import {parseQuoteEvent, canonicalHash, observationDay, dayBounds} from "./quote-event.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_POLICY = Object.freeze({
  version: "quote-substitution-1",
  timezone: "Asia/Shanghai",
  maximum_quality_delta: 1,
  quality_grade_order: ["A", "B", "C"],
  store_level_order: ["flagship", "standard", "community"],
  candidate_selection: {
    order: ["same_spec_same_region", "same_spec_adjacent_region", "equivalent_quality_same_region"],
    max_quote_age_ms: 7 * MS_PER_DAY,
    prefer_fresher_quote_ms: 2 * 60 * 60 * 1000,
  },
  substitution: {
    max_chain_length: 3,
    expire_after_ms_without_restore: 7 * MS_PER_DAY,
    auto_approve_zero_delta: false,
  },
  index: {
    aggregation: "geometric_mean",
    min_points_per_region: 1,
    open_period_days: 2,
  },
});

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function stableKey(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(",")}}`;
}

function rankOf(list, value) {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
}

export class PriceEngine {
  constructor(store, policy = DEFAULT_POLICY, clock = () => Date.now(), hooks = {}) {
    this.store = store;
    this.clock = clock;
    this.defaultPolicy = policy;
    // 提交前钩子：模拟重算耗时时，迟到事件可以推进修订号并触发回写阻止。
    this.beforeRecomputeCommit = hooks.beforeRecomputeCommit ?? null;
  }

  // ---------- 策略版本 ----------

  async registerPolicy(policy, effectiveFromMs = this.clock()) {
    if (!policy || typeof policy.version !== "string") {
      throw new EngineError("invalid_policy", "策略缺少 version");
    }
    return this.store.update((d) => {
      if (d.policies[policy.version]) {
        return {status: "duplicate", version: policy.version};
      }
      d.policies[policy.version] = {...structuredClone(policy), effective_from_ms: effectiveFromMs};
      d.policyOrder.push(policy.version);
      d.policyOrder.sort((a, b) => d.policies[a].effective_from_ms - d.policies[b].effective_from_ms);
      return {status: "registered", version: policy.version};
    });
  }

  policyAt(state, atMs) {
    let chosen = null;
    for (const v of state.policyOrder) {
      if (state.policies[v].effective_from_ms <= atMs) chosen = state.policies[v];
    }
    return chosen ?? state.policies[state.policyOrder[0]] ?? this.defaultPolicy;
  }

  // ---------- 采价点档案 ----------

  async upsertPoint(profile) {
    const required = ["point_id", "product_id", "region", "store_level"];
    for (const f of required) {
      if (typeof profile?.[f] !== "string" || profile[f].trim() === "") {
        throw new EngineError("invalid_point", `采价点档案缺少 ${f}`);
      }
    }
    const clean = {
      point_id: profile.point_id,
      product_id: profile.product_id,
      region: profile.region,
      region_group: profile.region_group ?? null,
      store_level: profile.store_level,
      spec: profile.spec ? structuredClone(profile.spec) : {},
      quality_grade: profile.quality_grade ?? null,
    };
    return this.store.update((d) => {
      d.points[clean.point_id] = {...d.points[clean.point_id], ...clean};
      return d.points[clean.point_id];
    });
  }

  // ---------- 事件接收：来源序号幂等 + 同标识异文隔离 ----------

  async ingest(rawEvent) {
    let record;
    try {
      record = parseQuoteEvent(rawEvent);
    } catch (err) {
      throw new EngineError("invalid_event", err.message);
    }
    const hash = canonicalHash(rawEvent);
    const now = this.clock();
    const seqKey = `${record.source_id}:${record.source_seq}`;

    return this.store.update((d) => {
      // 来源序号幂等：不同 event_id 复用同一来源序号一律隔离。
      const seqOwner = d.sourceSeqIndex[seqKey];
      if (seqOwner && seqOwner !== record.event_id) {
        return this.#quarantine(d, record, rawEvent, hash, "source_seq_conflict", seqOwner, now);
      }
      const existing = d.events[record.event_id];
      if (existing) {
        if (existing.hash === hash) {
          return {status: "duplicate", event_id: record.event_id, source_seq: record.source_seq};
        }
        return this.#quarantine(d, record, rawEvent, hash, "content_conflict", record.event_id, now);
      }

      const stored = {
        ...record,
        hash,
        payload: structuredClone(rawEvent),
        received_at_ms: now,
      };
      d.events[record.event_id] = stored;
      d.sourceSeqIndex[seqKey] = record.event_id;

      // 报价携带档案字段时自动补登采价点。
      const p = d.points[record.point_id];
      if (!p && rawEvent.product_id) {
        d.points[record.point_id] = {
          point_id: record.point_id,
          product_id: String(rawEvent.product_id),
          region: String(rawEvent.region ?? "UNKNOWN"),
          region_group: rawEvent.region_group ?? null,
          store_level: String(rawEvent.store_level ?? "standard"),
          spec: rawEvent.spec ? structuredClone(rawEvent.spec) : {},
          quality_grade: record.quality_grade ?? rawEvent.quality_grade ?? null,
        };
      } else if (p && record.event_type === "quality_change") {
        p.quality_grade = record.quality_grade;
      }

      this.#afterEvent(d, stored, now);
      return {status: "accepted", event_id: record.event_id, source_seq: record.source_seq};
    });
  }

  #quarantine(d, record, rawEvent, hash, reason, conflictWith, now) {
    if (!d.quarantine[record.event_id] || d.quarantine[record.event_id].reason !== reason) {
      d.quarantine[record.event_id] = {
        event_id: record.event_id,
        point_id: record.point_id,
        source_seq: record.source_seq,
        source_id: record.source_id,
        reason,
        conflict_with: conflictWith,
        hash,
        payload: structuredClone(rawEvent),
        status: "pending",
        received_at_ms: now,
      };
      // 隔离处理任务：重启后仍会被 tick 拾起继续跟进。
      this.#addTask(d, {
        type: "quarantine_resolve",
        due_at_ms: now,
        payload: {event_id: record.event_id, reason},
      });
    }
    return {status: "quarantined", event_id: record.event_id, reason, conflict_with: conflictWith};
  }

  /** 事件接收后的派生动作（同一串行事务内完成）。 */
  #afterEvent(d, event, now) {
    if (event.event_type === "unavailable") {
      this.#addTask(d, {
        type: "evaluate_substitution",
        due_at_ms: now,
        payload: {point_id: event.point_id, failure_ms: event.observed_at_ms},
      });
    }
    if (event.event_type === "restored") {
      // 跨日恢复只关闭有效区间，不回改任何已发布观察值。
      for (const sub of Object.values(d.substitutions)) {
        if (
          sub.failed_point_id === event.point_id &&
          sub.status === "active" &&
          sub.valid_from_ms < event.observed_at_ms &&
          sub.valid_to_ms > event.observed_at_ms
        ) {
          sub.valid_to_ms = event.observed_at_ms;
          sub.status = "closed";
          sub.close_reason = "restored";
          sub.closed_at_ms = event.observed_at_ms;
        }
      }
    }
    // 报价/恢复/质量变更可能影响其观察日；只有该期间仍开放才登记重算。
    if (["quoted", "restored", "quality_change"].includes(event.event_type)) {
      const point = d.points[event.point_id];
      if (point) {
        const policy = this.policyAt(d, now);
        const tz = policy.timezone ?? "Asia/Shanghai";
        const day = observationDay(event.observed_at_ms, tz);
        if (this.isOpenPeriod(day, now, policy)) {
          this.#enqueueRecompute(d, `${point.product_id}|${point.region}|${day}`, now);
        }
      }
    }
  }

  async resolveQuarantine(eventId, action, {by = "operator", correctedEvent = null} = {}) {
    if (!["accept", "reject"].includes(action)) {
      throw new EngineError("invalid_action", "action 必须是 accept 或 reject");
    }
    // accept 走标准接收通道（来源序号/异文规则仍然生效）。
    if (action === "accept") {
      const q = this.store.snapshot().quarantine[eventId];
      if (!q) throw new EngineError("not_found", "隔离记录不存在");
      const payload = correctedEvent ?? q.payload;
      const result = await this.ingest(payload);
      if (result.status === "quarantined") {
        throw new EngineError("still_conflicted", `仍然无法接收：${result.reason}`);
      }
      await this.store.update((d) => {
        const rec = d.quarantine[eventId];
        if (rec) {
          rec.status = "accepted";
          rec.resolved_by = by;
          rec.resolved_at_ms = this.clock();
        }
        this.#cancelTasks(d, (t) => t.type === "quarantine_resolve" && t.payload.event_id === eventId);
      });
      return result;
    }
    return this.store.update((d) => {
      const rec = d.quarantine[eventId];
      if (!rec) throw new EngineError("not_found", "隔离记录不存在");
      rec.status = "rejected";
      rec.resolved_by = by;
      rec.resolved_at_ms = this.clock();
      this.#cancelTasks(d, (t) => t.type === "quarantine_resolve" && t.payload.event_id === eventId);
      return rec;
    });
  }

  // ---------- 任务台账 ----------

  #addTask(d, {type, due_at_ms, payload, basis_cursor = null}) {
    const id = this.store.nextId(d, "task");
    d.tasks[id] = {
      task_id: id,
      type,
      due_at_ms,
      payload: structuredClone(payload ?? {}),
      basis_cursor: basis_cursor ?? d.revision ?? 0,
      status: "pending",
      attempts: 0,
      created_at_ms: this.clock(),
    };
    return id;
  }

  #cancelTasks(d, predicate) {
    for (const t of Object.values(d.tasks)) {
      if ((t.status === "pending" || t.status === "running") && predicate(t)) t.status = "cancelled";
    }
  }

  #enqueueRecompute(d, key, now) {
    const period = d.indexPeriods[key];
    // 已发布即冻结：迟到事件/新替代不再为它登记重算。
    if (period?.status === "published") return;
    const exists = Object.values(d.tasks).some(
      (t) => t.type === "recompute_index" && t.payload.key === key && (t.status === "pending" || t.status === "running"),
    );
    if (!exists) this.#addTask(d, {type: "recompute_index", due_at_ms: now, payload: {key}});
  }

  /** 重启恢复：执行所有到期任务。返回各类任务的执行计数。 */
  async tick(now = this.clock(), {limit = 100} = {}) {
    const report = {evaluated: 0, expired: 0, recomputed: 0, stale_blocked: 0, quarantine_pending: 0, executed: []};
    for (let i = 0; i < limit; i += 1) {
      const snap = this.store.snapshot();
      const due = Object.values(snap.tasks)
        .filter((t) => t.status === "pending" && t.due_at_ms <= now)
        .sort((a, b) => a.due_at_ms - b.due_at_ms)[0];
      if (!due) break;

      if (due.type === "quarantine_resolve") {
        report.quarantine_pending += 1;
        // 隔离记录等待人工处置；挂起任务保留，重启后继续可见。
        await this.store.update((d) => {
          d.tasks[due.task_id].attempts += 1;
          d.tasks[due.task_id].due_at_ms = now + 60 * 1000;
        });
        continue;
      }
      if (due.type === "evaluate_substitution") {
        try {
          await this.#runEvaluation(due.payload.point_id, due.payload.failure_ms, {taskId: due.task_id});
          report.evaluated += 1;
          report.executed.push(due.task_id);
        } catch (err) {
          // 单个任务失败不能拖垮重启恢复：记录错误并退避重试。
          await this.store.update((d) => {
            d.tasks[due.task_id].status = "pending";
            d.tasks[due.task_id].due_at_ms = now + 60 * 1000;
            d.tasks[due.task_id].last_error = `${err.code ?? "error"}: ${err.message}`;
            d.tasks[due.task_id].attempts += 1;
          });
        }
        continue;
      }
      if (due.type === "substitution_expiry") {
        await this.store.update((d) => {
          const sub = d.substitutions[due.payload.sub_id];
          if (sub && sub.status === "active") {
            sub.status = "expired";
            sub.expired_at_ms = now;
            report.expired += 1;
          }
          d.tasks[due.task_id].status = "done";
          d.tasks[due.task_id].finished_at_ms = now;
        });
        continue;
      }
      if (due.type === "recompute_index") {
        const result = await this.recomputePeriod(due.payload.key, {taskId: due.task_id});
        if (result === "stale_blocked") report.stale_blocked += 1;
        else report.recomputed += 1;
        report.executed.push(due.task_id);
      }
    }
    return report;
  }

  // ---------- 候选评估与替代决定 ----------

  async #runEvaluation(pointId, failureMs, {taskId = null, source = "event"} = {}) {
    // 候选清单的计算在锁外完成（只读快照），落库在串行事务内。
    const snap = this.store.snapshot();
    const failed = snap.points[pointId];
    if (!failed) throw new EngineError("not_found", `采价点不存在: ${pointId}`);
    const policy = this.policyAt(snap, failureMs);
    const evaluation = this.#buildEvaluation(snap, failed, failureMs, policy, source);

    return this.store.update((d) => {
      d.evaluations[evaluation.eval_id] = evaluation;
      if (taskId && d.tasks[taskId]) {
        d.tasks[taskId].status = "done";
        d.tasks[taskId].finished_at_ms = this.clock();
      }
      // 零质量差异可按策略自动批准，其余进入人工审批。
      const chosen = evaluation.candidates.find((c) => c.selected);
      if (chosen && policy.substitution?.auto_approve_zero_delta && chosen.quality_delta === 0) {
        this.#createSubstitution(d, evaluation, chosen, {
          approved_by: "policy:auto",
          basis: `策略 ${policy.version} 允许零质量差异自动批准`,
          validToMs: chosen.max_valid_to_ms,
        });
      }
      return d.evaluations[evaluation.eval_id];
    });
  }

  /** 显式触发评估（接口使用）。 */
  async evaluateSubstitution(pointId, atMs = this.clock()) {
    return this.#runEvaluation(pointId, atMs, {source: "manual"});
  }

  #buildEvaluation(state, failed, failureMs, policy, source) {
    const tz = policy.timezone ?? "Asia/Shanghai";
    const day = observationDay(failureMs, tz);
    // 候选价以失效时刻为准（失效之后才出现的报价不能回溯充当当时的候选）。
    const dayEnd = failureMs;
    const maxDelta = policy.maximum_quality_delta ?? 1;
    const sel = policy.candidate_selection ?? {};
    const maxAge = sel.max_quote_age_ms ?? 7 * MS_PER_DAY;
    const gradeOrder = policy.quality_grade_order ?? ["A", "B", "C"];
    const levelOrder = policy.store_level_order ?? ["flagship", "standard", "community"];
    const failedGrade = this.#gradeAt(state, failed.point_id, failureMs) ?? failed.quality_grade;

    const candidates = [];
    for (const c of Object.values(state.points)) {
      if (c.point_id === failed.point_id || c.product_id !== failed.product_id) continue;
      const cand = {
        point_id: c.point_id,
        region: c.region,
        store_level: c.store_level,
        quality_grade: this.#gradeAt(state, c.point_id, dayEnd) ?? c.quality_grade,
        eligible: true,
        reasons: [],
      };
      const quote = this.#latestQuote(state, c.point_id, dayEnd);
      if (!quote) {
        cand.eligible = false;
        cand.reasons.push("no_quote");
      } else {
        cand.quote_event_id = quote.event_id;
        cand.price = quote.price;
        cand.quote_age_ms = dayEnd - quote.observed_at_ms;
        if (cand.quote_age_ms > maxAge) {
          cand.eligible = false;
          cand.reasons.push("quote_too_old");
        }
      }
      const stateAt = this.#pointStateAt(state, c.point_id, dayEnd);
      if (stateAt === "unavailable") {
        cand.eligible = false;
        cand.reasons.push("candidate_unavailable");
      }
      cand.quality_delta = Math.abs(rankOf(gradeOrder, cand.quality_grade ?? failedGrade) - rankOf(gradeOrder, failedGrade ?? cand.quality_grade));
      if (cand.quality_delta > maxDelta) {
        cand.eligible = false;
        cand.reasons.push("quality_delta_exceeds_maximum");
      }
      const specEqual = stableKey(c.spec ?? {}) === stableKey(failed.spec ?? {});
      if (specEqual && c.region === failed.region) cand.tier = 0;
      else if (specEqual && c.region_group && c.region_group === failed.region_group) cand.tier = 1;
      else if (c.region === failed.region) cand.tier = 2;
      else {
        cand.tier = 3;
        cand.eligible = false;
        cand.reasons.push("no_matching_selection_tier");
      }
      cand.tier_name = (sel.order ?? [])[cand.tier] ?? `tier_${cand.tier}`;
      cand.store_level_distance = Math.abs(rankOf(levelOrder, c.store_level) - rankOf(levelOrder, failed.store_level));
      candidates.push(cand);
    }

    // 未采用原因：落选的合格候选记录排名靠后。
    const ranked = candidates
      .filter((c) => c.eligible)
      .sort((a, b) =>
        a.tier - b.tier ||
        a.quality_delta - b.quality_delta ||
        a.store_level_distance - b.store_level_distance ||
        (a.quote_age_ms ?? 0) - (b.quote_age_ms ?? 0) ||
        a.point_id.localeCompare(b.point_id),
      );
    for (const c of candidates.filter((c) => c.eligible && c !== ranked[0])) {
      c.reasons.push("ranked_lower");
    }
    if (ranked[0]) ranked[0].selected = true;

    const evalId = `eval-${failed.point_id}-${day}`;
    const expireAfter = policy.substitution?.expire_after_ms_without_restore ?? 7 * MS_PER_DAY;
    return {
      eval_id: evalId,
      source,
      failed_point_id: failed.point_id,
      product_id: failed.product_id,
      failure_ms: failureMs,
      observation_day: day,
      policy_version: policy.version,
      policy_snapshot: structuredClone(policy),
      candidates: candidates.sort((a, b) =>
        a.tier - b.tier || b.eligible - a.eligible || a.point_id.localeCompare(b.point_id)),
      selected_point_id: ranked[0]?.point_id ?? null,
      status: ranked[0] ? "awaiting_approval" : "no_candidate",
      default_valid_from_ms: failureMs,
      default_valid_to_ms: failureMs + expireAfter,
      created_at_ms: this.clock(),
    };
  }

  /** 审批替代决定；固定规格/地区/层级/质量差异/有效区间/审批依据，并做防环校验。 */
  async approveSubstitution(evalId, {by = "approver", basis, validFromMs = null, validToMs = null, candidatePointId = null} = {}) {
    if (typeof basis !== "string" || basis.trim() === "") {
      throw new EngineError("invalid_approval", "审批依据 basis 必填");
    }
    return this.store.update((d) => {
      const evaluation = d.evaluations[evalId];
      if (!evaluation) throw new EngineError("not_found", `评估不存在: ${evalId}`);
      const named = candidatePointId
        ? evaluation.candidates.find((c) => c.point_id === candidatePointId)
        : null;
      const candidate = named ?? evaluation.candidates.find((c) => c.selected);
      if (!candidate) throw new EngineError("no_candidate", "没有候选可供批准");
      // 自动选择只能选合格候选；审批人显式指定时允许人工覆盖合格性（留痕），
      // 但成环/超长校验在任何情况下都不可绕过。
      let manual_override = false;
      if (!candidate.eligible) {
        if (!named) throw new EngineError("no_candidate", "没有合格候选可供批准");
        manual_override = true;
      }
      const from = validFromMs ?? evaluation.default_valid_from_ms;
      const to = validToMs ?? evaluation.default_valid_to_ms;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        throw new EngineError("invalid_interval", "替代有效区间非法");
      }
      // 防环：沿 active 替代边 failed -> candidate 不得成环；链长按评估时规则版本判定。
      this.#assertNoCycle(d, evaluation.failed_point_id, candidate.point_id, evaluation.policy_snapshot);

      const sub = this.#createSubstitution(d, evaluation, candidate, {
        approved_by: by,
        basis,
        validFromMs: from,
        validToMs: to,
        manual_override,
      });
      return sub;
    });
  }

  #assertNoCycle(state, failedId, candidateId, policy = null) {
    const maxChain = policy?.substitution?.max_chain_length
      ?? this.policyAt(state, this.clock()).substitution?.max_chain_length
      ?? 3;
    const activeEdges = new Map();
    for (const s of Object.values(state.substitutions)) {
      if (s.status === "active") activeEdges.set(s.failed_point_id, s.candidate.point_id);
    }
    // 从候选沿 active 边出发：回到失效点即成环；计入新边后链长不得超过 maxChain。
    const seen = new Set([failedId]);
    let cur = candidateId;
    let depth = 1; // 新批准的 failed -> candidate 即第一条边
    while (cur) {
      if (seen.has(cur)) throw new EngineError("cycle_detected", "替代链成环，拒绝批准");
      if (depth > maxChain) throw new EngineError("chain_too_long", `替代链超过 ${maxChain} 层`);
      seen.add(cur);
      cur = activeEdges.get(cur);
      depth += 1;
    }
  }

  #createSubstitution(d, evaluation, candidate, {approved_by, basis, validFromMs, validToMs, manual_override = false}) {
    const failed = d.points[evaluation.failed_point_id];
    const subId = this.store.nextId(d, "sub");
    const sub = {
      sub_id: subId,
      eval_id: evaluation.eval_id,
      policy_version: evaluation.policy_version,
      failed_point_id: failed.point_id,
      product_id: failed.product_id,
      // 替代决定固定的要素，事后档案变更不影响本决定。
      fixed: {
        spec: structuredClone(failed.spec ?? {}),
        region: failed.region,
        store_level: failed.store_level,
      },
      candidate: {
        point_id: candidate.point_id,
        region: candidate.region,
        store_level: candidate.store_level,
        quality_grade: candidate.quality_grade ?? null,
        quality_delta: candidate.quality_delta,
        tier: candidate.tier,
        tier_name: candidate.tier_name,
        quote_event_id: candidate.quote_event_id ?? null,
        manual_override,
        not_adopted_reasons: candidate.reasons ?? [],
      },
      valid_from_ms: validFromMs,
      valid_to_ms: validToMs,
      status: "active",
      approval: {approved_by, basis, approved_at_ms: this.clock()},
      created_at_ms: this.clock(),
    };
    d.substitutions[subId] = sub;
    evaluation.status = "approved";
    evaluation.approved_sub_id = subId;

    // 到期替代任务：到 valid_to_ms 自动失效，之后保留缺口。
    this.#addTask(d, {
      type: "substitution_expiry",
      due_at_ms: validToMs,
      payload: {sub_id: subId},
    });
    // 新替代影响开放期间，登记重算。
    const tz = this.policyAt(d, this.clock()).timezone ?? "Asia/Shanghai";
    const day = evaluation.observation_day ?? observationDay(validFromMs, tz);
    this.#enqueueRecompute(d, `${sub.product_id}|${sub.fixed.region}|${day}`, this.clock());
    return sub;
  }

  // ---------- 价格采用与指数 ----------

  #eventsOf(state, pointId) {
    return Object.values(state.events)
      .filter((e) => e.point_id === pointId)
      .sort((a, b) => a.observed_at_ms - b.observed_at_ms || a.source_seq - b.source_seq);
  }

  #latestQuote(state, pointId, atMs) {
    let best = null;
    for (const e of this.#eventsOf(state, pointId)) {
      if (e.observed_at_ms > atMs) break;
      if (e.event_type === "quoted" || (e.event_type === "restored" && typeof e.price === "number") || (e.event_type === "quality_change" && typeof e.price === "number")) best = e;
    }
    return best;
  }

  #gradeAt(state, pointId, atMs) {
    let grade = null;
    for (const e of this.#eventsOf(state, pointId)) {
      if (e.observed_at_ms > atMs) break;
      if (typeof e.quality_grade === "string") grade = e.quality_grade;
    }
    return grade;
  }

  #pointStateAt(state, pointId, atMs) {
    let s = "active";
    for (const e of this.#eventsOf(state, pointId)) {
      if (e.observed_at_ms > atMs) break;
      if (e.event_type === "unavailable") s = "unavailable";
      if (e.event_type === "restored") s = "active";
    }
    return s;
  }

  #activeSubsAt(state, pointId, atMs) {
    return Object.values(state.substitutions)
      .filter(
        (s) =>
          s.failed_point_id === pointId &&
          s.valid_from_ms <= atMs &&
          s.valid_to_ms > atMs &&
          (s.status === "active" || s.status === "closed" || s.status === "expired"),
      )
      .sort((a, b) => b.created_at_ms - a.created_at_ms);
  }

  /**
   * 还原某采价点在观察日的采用价与替代路径。
   * 无合格候选时返回 gap:true，绝不沿用过期价格。
   */
  resolvePoint(state, pointId, atMs, chain = []) {
    if (chain.includes(pointId)) {
      return {point_id: pointId, gap: true, reason: "cycle_guard", path: chain};
    }
    const pointState = this.#pointStateAt(state, pointId, atMs);
    const quote = this.#latestQuote(state, pointId, atMs);
    if (pointState === "active") {
      if (!quote) return {point_id: pointId, gap: true, reason: "no_quote", path: [...chain, pointId]};
      return {
        point_id: pointId,
        price: quote.price,
        source_event_id: quote.event_id,
        quality_grade: this.#gradeAt(state, pointId, atMs),
        path: [...chain, pointId],
      };
    }
    const subs = this.#activeSubsAt(state, pointId, atMs);
    for (const sub of subs) {
      const resolved = this.resolvePoint(state, sub.candidate.point_id, atMs, [...chain, pointId]);
      if (!resolved.gap) {
        return {
          ...resolved,
          failed_point_id: pointId,
          substituted_via: sub.sub_id,
          substitution: {
            sub_id: sub.sub_id,
            policy_version: sub.policy_version,
            candidate: sub.candidate,
            fixed: sub.fixed,
            valid_from_ms: sub.valid_from_ms,
            valid_to_ms: sub.valid_to_ms,
            approval: sub.approval,
          },
        };
      }
    }
    return {point_id: pointId, gap: true, reason: subs.length ? "substitution_chain_gap" : "no_candidate", path: [...chain, pointId]};
  }

  periodKey(productId, region, day) {
    return `${productId}|${region}|${day}`;
  }

  isOpenPeriod(day, now, policy) {
    const tz = policy.timezone ?? "Asia/Shanghai";
    const [dayStart] = dayBounds(day, tz);
    const openDays = policy.index?.open_period_days ?? 2;
    return now - dayStart < openDays * MS_PER_DAY && dayStart <= now;
  }

  /** 计算某期间的观察值（纯函数，基于传入快照，保证乐观锁判断在锁外可做）。 */
  computePeriod(state, key, atMs, ruleVersionOverride = null) {
    const [productId, region, day] = key.split("|");
    const policy =
      (ruleVersionOverride && state.policies[ruleVersionOverride]) ||
      this.policyAt(state, atMs);
    const tz = policy.timezone ?? "Asia/Shanghai";
    const [, dayEndRaw] = dayBounds(day, tz);
    // 采用时刻不得越过当前时钟：未来时刻才发生的报价不能提前进入指数。
    const dayEnd = Math.min(dayEndRaw, atMs);
    const points = Object.values(state.points).filter((p) => p.product_id === productId && p.region === region);

    const contributions = points.map((p) => {
      const r = this.resolvePoint(state, p.point_id, dayEnd);
      return {
        point_id: p.point_id,
        adopted: !r.gap,
        price: r.gap ? null : r.price,
        source_event_id: r.source_event_id ?? null,
        substituted_via: r.substituted_via ?? null,
        path: r.path,
        reason: r.gap ? r.reason : null,
      };
    });
    const adopted = contributions.filter((c) => c.adopted);
    const minPoints = policy.index?.min_points_per_region ?? 1;
    let value = null;
    let gap_reason = null;
    if (adopted.length < minPoints) {
      gap_reason = "insufficient_points";
    } else if (adopted.length === 1) {
      value = adopted[0].price;
    } else if ((policy.index?.aggregation ?? "geometric_mean") === "arithmetic_mean") {
      value = adopted.reduce((acc, c) => acc + c.price, 0) / adopted.length;
    } else if (adopted.every((c) => c.price === adopted[0].price)) {
      // 同价时几何平均就是该价，避免 log/exp 引入浮点误差。
      value = adopted[0].price;
    } else {
      const logSum = adopted.reduce((acc, c) => acc + Math.log(c.price), 0);
      value = Math.exp(logSum / adopted.length);
    }
    return {
      key,
      product_id: productId,
      region,
      observation_day: day,
      rule_version: policy.version,
      value,
      gap_reason,
      point_count: points.length,
      adopted_count: adopted.length,
      contributions,
      computed_at_ms: atMs,
    };
  }

  /**
   * 重算开放期间。采用乐观并发：计算基于开始时的快照游标，
   * 提交时若已有迟到事件推进了游标，阻止旧结果回写并稍后重试。
   */
  async recomputePeriod(key, {taskId = null} = {}) {
    const base = this.store.snapshot();
    const now = this.clock();
    const computed = this.computePeriod(base, key, now);
    // 乐观游标：计算开始时的修订号；提交时若有迟到事件推进了修订号则阻止回写。
    const cursor = base.revision;
    if (this.beforeRecomputeCommit) await this.beforeRecomputeCommit({key});

    return this.store.update((d) => {
      const task = taskId ? d.tasks[taskId] : null;
      if (task) task.attempts += 1;
      // 迟到事件（或任何台账推进）使旧结果失效：阻止回写，任务稍后重试。
      if (d.revision !== cursor) {
        if (task) {
          task.status = "pending";
          task.due_at_ms = this.clock();
          task.basis_cursor = d.revision;
          task.last_result = "stale_blocked";
        }
        return "stale_blocked";
      }
      const existing = d.indexPeriods[key];
      if (existing?.status === "published") {
        if (task) {
          task.status = "done";
          task.finished_at_ms = this.clock();
          task.last_result = "published_frozen";
        }
        return "published_frozen";
      }
      const [, , day] = key.split("|");
      const policy = this.policyAt(d, now);
      if (!this.isOpenPeriod(day, now, policy)) {
        if (task) {
          task.status = "done";
          task.finished_at_ms = this.clock();
          task.last_result = "period_closed";
        }
        return "period_closed";
      }
      const version = existing && existing.values.length ? existing.values[existing.values.length - 1].version + 1 : 1;
      const entry = {version, ...computed, computed_at_ms: this.clock()};
      const period = existing ?? {
        key,
        product_id: computed.product_id,
        region: computed.region,
        observation_day: day,
        status: "open",
        values: [],
        published_version: null,
        correction_ids: [],
        created_at_ms: this.clock(),
      };
      period.values.push(entry);
      period.rule_version = entry.rule_version;
      d.indexPeriods[key] = period;
      if (task) {
        task.status = "done";
        task.finished_at_ms = this.clock();
        task.last_result = "recomputed";
      }
      return entry;
    });
  }

  async publishIndex(key, {by = "publisher"} = {}) {
    return this.store.update((d) => {
      const period = d.indexPeriods[key];
      if (!period || period.values.length === 0) throw new EngineError("not_computed", "期间尚未计算");
      if (period.status === "published") throw new EngineError("already_published", "期间已发布，不可重复发布");
      const entry = period.values[period.values.length - 1];
      if (entry.value === null) throw new EngineError("gap_not_publishable", "观察值缺口期间不能发布");
      period.status = "published";
      period.published_version = entry.version;
      period.published_at_ms = this.clock();
      period.published_by = by;
      // 已发布：取消针对该期间的待执行重算，跨日恢复也不能改写。
      this.#cancelTasks(d, (t) => t.type === "recompute_index" && t.payload.key === key);
      return period;
    });
  }

  // ---------- 规则更正 ----------

  async createCorrection({policy_version, product_id, region, from_day, to_day, reason, by = "analyst"}) {
    if (!policy_version || !reason) throw new EngineError("invalid_correction", "policy_version 与 reason 必填");
    return this.store.update((d) => {
      if (!d.policies[policy_version]) throw new EngineError("not_found", `策略版本不存在: ${policy_version}`);
      const id = this.store.nextId(d, "corr");
      d.corrections[id] = {
        correction_id: id,
        policy_version,
        scope: {product_id, region, from_day, to_day},
        reason,
        status: "pending",
        created_by: by,
        created_at_ms: this.clock(),
        changes: [],
        frozen_periods: [],
      };
      return d.corrections[id];
    });
  }

  /** 批准更正：只重算开放期间；已发布期间保留旧值，仅登记差异与批准关系。 */
  async approveCorrection(correctionId, {by = "approver", basis} = {}) {
    if (typeof basis !== "string" || !basis.trim()) throw new EngineError("invalid_approval", "批准依据 basis 必填");
    const now = this.clock();
    const snap = this.store.snapshot();
    const corr = snap.corrections[correctionId];
    if (!corr) throw new EngineError("not_found", "更正单不存在");
    if (corr.status !== "pending") throw new EngineError("invalid_state", "更正单不是待批准状态");
    const policy = snap.policies[corr.policy_version];

    // 锁外计算所有候选结果，提交时一次性做游标守卫。
    const targets = Object.values(snap.indexPeriods).filter(
      (p) =>
        p.product_id === corr.scope.product_id &&
        (corr.scope.region ? p.region === corr.scope.region : true) &&
        p.observation_day >= corr.scope.from_day &&
        p.observation_day <= corr.scope.to_day,
    );
    const plans = targets.map((p) => ({
      key: p.key,
      status: p.status,
      oldEntry: p.values[p.values.length - 1],
      computed: this.computePeriod(snap, p.key, now, corr.policy_version),
    }));
    const cursor = snap.revision;

    return this.store.update((d) => {
      if (d.revision !== cursor) throw new EngineError("concurrent_change", "台账已被迟到事件推进，请重新批准");
      const record = d.corrections[correctionId];
      for (const plan of plans) {
        const period = d.indexPeriods[plan.key];
        if (period.status === "published") {
          // 已发布指数保留旧值；记录新旧差异，供回溯说明“没有改写”。
          record.frozen_periods.push({
            key: plan.key,
            old_value: plan.oldEntry.value,
            would_be_value: plan.computed.value,
            diff: plan.computed.value === null || plan.oldEntry.value === null ? null : plan.computed.value - plan.oldEntry.value,
            published_version: period.published_version,
          });
          continue;
        }
        if (!this.isOpenPeriod(period.observation_day, now, policy)) continue;
        const version = plan.oldEntry.version + 1;
        const entry = {version, ...plan.computed, computed_at_ms: this.clock(), correction_id: correctionId};
        period.values.push(entry);
        period.rule_version = corr.policy_version;
        period.correction_ids.push(correctionId);
        record.changes.push({
          key: plan.key,
          from_version: plan.oldEntry.version,
          old_value: plan.oldEntry.value,
          new_value: entry.value,
          diff: entry.value === null || plan.oldEntry.value === null ? null : entry.value - plan.oldEntry.value,
          applied_version: version,
        });
      }
      record.status = "approved";
      record.approval = {approved_by: by, basis, approved_at_ms: this.clock()};
      return record;
    });
  }

  // ---------- 任一观察时刻溯源 ----------

  trace({pointId = null, productId = null, region = null, atMs = this.clock()}) {
    const s = this.store.snapshot();
    const tz = this.policyAt(s, atMs).timezone ?? "Asia/Shanghai";
    const result = {at_ms: atMs, observation_day: observationDay(atMs, tz), points: [], indexes: []};

    const pointIds = pointId
      ? [pointId]
      : Object.values(s.points)
          .filter((p) => p.product_id === productId && (region ? p.region === region : true))
          .map((p) => p.point_id);

    for (const pid of pointIds) {
      const events = this.#eventsOf(s, pid)
        .filter((e) => e.observed_at_ms <= atMs)
        .map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          source_seq: e.source_seq,
          source_id: e.source_id,
          observed_at: e.observed_at,
          observed_at_ms: e.observed_at_ms,
          price: e.price ?? null,
          quality_grade: e.quality_grade ?? null,
          received_at_ms: e.received_at_ms,
        }));
      const adopted = this.resolvePoint(s, pid, atMs);
      const subs = Object.values(s.substitutions)
        .filter((x) => (x.failed_point_id === pid || x.candidate.point_id === pid) && x.valid_from_ms <= atMs)
        .map((x) => ({
          sub_id: x.sub_id,
          eval_id: x.eval_id,
          policy_version: x.policy_version,
          failed_point_id: x.failed_point_id,
          candidate: x.candidate,
          fixed: x.fixed,
          valid_from_ms: x.valid_from_ms,
          valid_to_ms: x.valid_to_ms,
          status: x.status,
          approval: x.approval,
        }));
      result.points.push({point_id: pid, events, adopted, substitutions: subs});
    }

    if (productId) {
      for (const period of Object.values(s.indexPeriods)) {
        if (period.product_id !== productId || (region && period.region !== region)) continue;
        if (period.observation_day > result.observation_day) continue;
        // 指数版本按系统计算时间可见：在该观察时刻之后算出的版本不得出现。
        const visible = period.values.filter((v) => v.computed_at_ms <= atMs);
        if (visible.length === 0) continue;
        const latest = visible[visible.length - 1];
        const publishedVisible = period.published_at_ms && period.published_at_ms <= atMs;
        result.indexes.push({
          key: period.key,
          observation_day: period.observation_day,
          status: publishedVisible ? "published" : "open",
          rule_version: latest.rule_version,
          versions: visible.map((v) => ({
            version: v.version,
            value: v.value,
            rule_version: v.rule_version,
            computed_at_ms: v.computed_at_ms,
            correction_id: v.correction_id ?? null,
          })),
          published_version: publishedVisible ? period.published_version : null,
          adopted_value: latest.value,
          contributions: latest.contributions,
          corrections: period.correction_ids.map((id) => s.corrections[id]).filter(Boolean).map((c) => ({
            correction_id: c.correction_id,
            policy_version: c.policy_version,
            status: c.status,
            reason: c.reason,
            approval: c.approval ?? null,
          })),
        });
      }
    }
    return result;
  }
}

export {DEFAULT_POLICY};
