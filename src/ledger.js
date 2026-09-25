import {validateQuoteEvent, payloadHash, observationDateOf} from "./quote-event.js";
import {selectPolicy, chooseCandidates, qualityRank} from "./policy.js";

const MAX_CHAIN_DEPTH = 16;

export class IngestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export class LedgerService {
  constructor(store) {
    this.store = store;
    if (this.store.state.policies.length === 0) {
      this.store.state.policies.push(this._withTimestamps(selectPolicy([], "2000-01-01")));
      this.store.save();
    }
  }

  _withTimestamps(object) {
    return {created_at: new Date().toISOString(), ...object};
  }

  get timezone() {
    return this.store.state.policies[0]?.timezone || "Asia/Shanghai";
  }

  // ---------------- 事件接收（幂等 / 隔离） ----------------

  /**
   * 接收一条采价事件。
   * - 同一 event_id + 同一内容指纹：幂等重放，返回 duplicate，不产生副作用；
   * - 同一 event_id + 不同内容：同标识异文，进入隔离，不覆盖既不触发替代；
   * - 新事件：落盘后驱动缺货/恢复副作用。
   */
  ingest(rawEvent) {
    let event;
    try {
      event = validateQuoteEvent(rawEvent);
    } catch (error) {
      throw new IngestError("invalid_event", error.message);
    }
    const hash = payloadHash(event);
    const existing = this.store.getEvent(event.event_id);
    if (existing) {
      if (existing._meta.payload_hash === hash) {
        this.store.acceptEvent({...event, payload_hash: hash}, {duplicate: true});
        return {status: "duplicate", event_id: event.event_id};
      }
      const quarantined = this.store.quarantineEvent({
        event,
        payload_hash: hash,
        conflict_with: existing.event_id,
        existing_payload_hash: existing._meta.payload_hash,
        reason: "same_identifier_different_payload",
      });
      return {status: "quarantined", quarantine_id: quarantined.quarantine_id};
    }
    const accepted = this.store.acceptEvent({...event, payload_hash: hash});
    this._reactToEvent(accepted);
    return {status: "accepted", event_id: event.event_id};
  }

  listQuarantine(status = null) {
    return this.store.state.quarantine.filter((q) => !status || q.status === status);
  }

  /** 隔离条目必须经审批才能被接受或丢弃；接受时补齐审批依据。 */
  resolveQuarantine(quarantineId, decision, approvalRef) {
    if (!["accept", "discard"].includes(decision)) {
      throw new IngestError("invalid_decision", "decision 必须是 accept 或 discard");
    }
    if (!approvalRef || typeof approvalRef !== "string") {
      throw new IngestError("approval_required", "隔离处理必须登记审批依据 approval_ref");
    }
    const entry = this.store.resolveQuarantine(quarantineId, decision, approvalRef);
    if (!entry) throw new IngestError("not_found", "隔离条目不存在");
    if (decision === "accept") {
      const event = {...entry.event, payload_hash: entry.payload_hash};
      const existingById = this.store.state.events[event.event_id];
      if (!existingById) {
        const stored = this.store.acceptEvent(event, {approvedFromQuarantine: true});
        stored._meta.approval_ref = approvalRef;
        stored._meta.approved_from_quarantine_id = quarantineId;
        this.store.save();
        this._reactToEvent(stored);
      } else {
        // 审批通过的异文取代原文：原文移入 revised_by，审批关系与旧指纹保留。
        existingById._meta.superseded_by = {
          payload_hash: entry.payload_hash, approval_ref: approvalRef, quarantine_id: quarantineId,
          superseded_at: new Date().toISOString(),
        };
        const stored = this.store.acceptEvent(event, {
          approvedFromQuarantine: true, supersede: true,
        });
        stored._meta.approval_ref = approvalRef;
        stored._meta.approved_from_quarantine_id = quarantineId;
        this._reactToEvent(stored);
      }
    }
    return entry;
  }

  // ---------------- 主数据：采价点与候选 ----------------

  registerPoint(point) {
    const required = ["point_id", "product_sku", "region", "store_tier", "quality_grade"];
    for (const key of required) {
      if (typeof point[key] !== "string" || point[key].trim() === "") {
        throw new IngestError("invalid_point", `${key} 不能为空`);
      }
    }
    const record = {
      point_id: point.point_id,
      product_sku: point.product_sku,
      region: point.region,
      store_tier: point.store_tier,
      quality_grade: point.quality_grade,
      updated_at: new Date().toISOString(),
    };
    this.store.state.points[point.point_id] = record;
    this.store.state.log_version += 1;
    this.store.save();
    return record;
  }

  registerCandidate(input) {
    const required = ["candidate_id", "point_id", "product_sku", "region", "store_tier", "quality_grade"];
    for (const key of required) {
      if (typeof input[key] !== "string" || input[key].trim() === "") {
        throw new IngestError("invalid_candidate", `${key} 不能为空`);
      }
    }
    const existing = this.store.state.candidates.find((c) => c.candidate_id === input.candidate_id);
    const record = {
      candidate_id: input.candidate_id,
      point_id: input.point_id,
      product_sku: input.product_sku,
      region: input.region,
      store_tier: input.store_tier,
      quality_grade: input.quality_grade,
      valid_from: input.valid_from ?? null,
      valid_to: input.valid_to ?? null,
      priority: Number.isFinite(input.priority) ? input.priority : 100,
      eligible: input.eligible !== false,
    };
    if (record.valid_from && record.valid_to && record.valid_from > record.valid_to) {
      throw new IngestError("invalid_candidate", "valid_from 不能晚于 valid_to");
    }
    if (existing) Object.assign(existing, record);
    else this.store.state.candidates.push(record);
    this.store.state.log_version += 1;
    this.store.save();
    // 不对历史缺口做墙钟日期的隐式重估；开放缺口由每日处理（显式日期）统一重放。
    return record;
  }

  /** 重估所有开放缺口：原采点已恢复则关单，仍缺货则按指定日规则重选。 */
  reevaluateGaps(today) {
    this._reevaluateOpenGaps(today);
  }

  _reevaluateOpenGaps(today) {
    let changed = false;
    for (const gap of [...this.store.state.substitutions]) {
      if (gap.status !== "gap" || gap.closure) continue;
      if (gap.valid_from > today) continue;
      const available = this.pointStatusAt(gap.failed_point_id, today) === "available";
      gap.status = "closed";
      gap.valid_to = this._prevDate(today);
      gap.closure = {
        reason: available ? "point_available_without_substitution" : "candidate_pool_rechecked",
        date: today,
      };
      changed = true;
      if (!available) this._ensureSubstitution(gap.failed_point_id, today);
    }
    if (changed) this.store.save();
  }

  registerPolicy(policy) {
    for (const key of ["version", "effective_from"]) {
      if (typeof policy[key] !== "string" || policy[key].trim() === "") {
        throw new IngestError("invalid_policy", `${key} 不能为空`);
      }
    }
    if (this.store.state.policies.some((p) => p.version === policy.version)) {
      throw new IngestError("policy_version_exists", "规则版本不可变，更正请登记新版本");
    }
    const record = this._withTimestamps({...selectPolicy(this.store.state.policies, policy.effective_from), ...policy});
    this.store.state.policies.push(record);
    this.store.state.policies.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    this.store.state.log_version += 1;
    this.store.save();
    return record;
  }

  // ---------------- 缺货 / 恢复副作用 ----------------

  _eventsOfPoint(pointId) {
    return this.store.listEvents()
      .filter((e) => e.point_id === pointId)
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.source_seq - b.source_seq);
  }

  /** 截至某日采点自身状态：最近一条缺货/恢复事件决定，默认可用。 */
  pointStatusAt(pointId, date) {
    const events = this._eventsOfPoint(pointId)
      .filter((e) => observationDateOf(e, this.timezone) <= date)
      .filter((e) => e.event_type === "unavailable" || e.event_type === "restored");
    const latest = events[events.length - 1];
    // restored 即视为可用；缺货中才返回 unavailable。
    return latest && latest.event_type === "unavailable" ? "unavailable" : "available";
  }

  /** 截至某日采点的质量等级：质量变更即时生效，其次取最近报价携带的等级；
   *  缺货/恢复事件携带的等级可能已过时，不参与判定。 */
  qualityGradeAt(pointId, date, fallback = "standard") {
    const events = this._eventsOfPoint(pointId)
      .filter((e) => observationDateOf(e, this.timezone) <= date)
      .filter((e) => e.event_type === "quality_change" || e.event_type === "quoted");
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.event_type === "quality_change") return e.new_quality_grade;
      if (e.quality_grade) return e.quality_grade;
    }
    return this.store.state.points[pointId]?.quality_grade || fallback;
  }

  _reactToEvent(event) {
    const date = observationDateOf(event, this.timezone);
    if (event.event_type === "unavailable") {
      this._ensureSubstitution(event.point_id, date, {trigger_event_id: event.event_id});
      // 乱序迟到：恢复事件可能已先到。已知恢复日早于/等于今日时，立即收口窗口。
      const laterRestore = this._eventsOfPoint(event.point_id)
        .filter((e) => e.event_type === "restored")
        .filter((e) => observationDateOf(e, this.timezone) >= date)
        .pop();
      if (laterRestore) {
        this._restorePoint(
          event.point_id, observationDateOf(laterRestore, this.timezone), laterRestore.event_id,
        );
      }
    } else if (event.event_type === "restored") {
      this._restorePoint(event.point_id, date, event.event_id);
    }
    this.processDueSubstitutions(date);
  }

  _restorePoint(pointId, date, eventId) {
    for (const sub of this.store.state.substitutions) {
      if (sub.failed_point_id !== pointId) continue;
      if (sub.status !== "active" && sub.status !== "gap") continue;
      // 跨日恢复只关闭“恢复日之后”的替代窗口：valid_to 固定为恢复日前一天，
      // 历史观察日仍沿原路径解析，绝不反向改写。
      sub.status = "closed";
      sub.closure = {reason: "restored", date, event_id: eventId};
      sub.valid_to = this._prevDate(date);
      this._schedule({type: "substitution_closed", run_at: date, ref: sub.substitution_id});
    }
    this.store.state.log_version += 1;
    this.store.save();
  }

  _prevDate(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  _activeSubstitution(pointId, date) {
    return this.store.state.substitutions.find((s) =>
      s.failed_point_id === pointId &&
      s.status === "active" &&
      s.valid_from <= date &&
      (s.valid_to === null || s.valid_to >= date));
  }

  /**
   * 替代链祖先：failed_point 沿既有替代关系向上追溯。
   * 选择新候选时排除整条链上的点，从源头保证链不成环。
   */
  _chainAncestors(pointId, date) {
    const ancestors = new Set();
    let current = pointId;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
      const incoming = this.store.state.substitutions.find((s) =>
        s.status === "active" &&
        s.replacement_point_id === current &&
        s.valid_from <= date &&
        (s.valid_to === null || s.valid_to >= date));
      if (!incoming || ancestors.has(incoming.failed_point_id)) break;
      ancestors.add(incoming.failed_point_id);
      current = incoming.failed_point_id;
    }
    return ancestors;
  }

  _substitutionContext(failedPointId, date) {
    const pointMeta = this.store.state.points[failedPointId];
    return {
      date,
      product_sku: pointMeta?.product_sku
        ?? this._eventsOfPoint(failedPointId).find((e) => e.product_sku)?.product_sku,
      region: pointMeta?.region
        ?? this._eventsOfPoint(failedPointId).find((e) => e.region)?.region,
      store_tier: pointMeta?.store_tier
        ?? this._eventsOfPoint(failedPointId).find((e) => e.store_tier)?.store_tier,
      quality_grade: this.qualityGradeAt(failedPointId, date, pointMeta?.quality_grade || "standard"),
    };
  }

  /** 在候选池中评分选择；链上点（含失效点自身）一律排除以防环。 */
  _evaluatePool(failedPointId, date, context, policy) {
    const ancestors = this._chainAncestors(failedPointId, date);
    ancestors.add(failedPointId);
    const pool = this.store.state.candidates;
    const excluded = pool
      .filter((c) => ancestors.has(c.point_id))
      .map((c) => ({
        candidate_id: c.candidate_id, point_id: c.point_id, quality_grade: c.quality_grade,
        valid_from: c.valid_from ?? null, valid_to: c.valid_to ?? null,
        quality_delta: null, eligible: false, selected: false,
        reasons: ["excluded_to_prevent_substitution_cycle"],
      }));
    const candidates = pool.filter((c) => !ancestors.has(c.point_id));
    const {selected, considered} = chooseCandidates(candidates, context, policy);
    return {selected, allConsidered: [...excluded, ...considered]};
  }

  _ensureSubstitution(failedPointId, date, options = {}) {
    const existing = this._activeSubstitution(failedPointId, date);
    if (existing) return existing;

    const policy = selectPolicy(this.store.state.policies, date);
    const context = this._substitutionContext(failedPointId, date);
    const {selected, allConsidered} = this._evaluatePool(failedPointId, date, context, policy);

    let record = null;
    if (selected) {
      record = {
        substitution_id: newId("sub"),
        failed_point_id: failedPointId,
        replacement_point_id: selected.point_id,
        candidate_id: selected.candidate_id,
        // 决定一旦做出即固定：规格、地区、门店层级、质量差异、有效区间、审批依据。
        product_sku: context.product_sku,
        region: context.region,
        store_tier: context.store_tier,
        quality_grade_failed: context.quality_grade,
        quality_grade_replacement: selected.quality_grade,
        quality_delta: Math.abs(
          qualityRank(selected.quality_grade, policy) - qualityRank(context.quality_grade, policy),
        ),
        valid_from: date,
        valid_to: selected.valid_to ?? null,
        policy_version: policy.version,
        approval_ref: options.approval_ref ?? policy.approval_ref ?? null,
        trigger_event_id: options.trigger_event_id ?? null,
        status: "active",
        closure: null,
        considered: allConsidered,
        created_at: new Date().toISOString(),
      };
      this.store.state.substitutions.push(record);
      if (record.valid_to) {
        this._schedule({type: "substitution_expiry", run_at: record.valid_to, ref: record.substitution_id});
      }
    } else {
      // 无合格候选：保留缺口决定（同样记录全部落选原因），不沿用任何过期价格。
      record = {
        substitution_id: newId("gap"),
        failed_point_id: failedPointId,
        replacement_point_id: null,
        candidate_id: null,
        product_sku: context.product_sku,
        region: context.region,
        store_tier: context.store_tier,
        quality_grade_failed: context.quality_grade,
        quality_grade_replacement: null,
        quality_delta: null,
        valid_from: date,
        valid_to: null,
        policy_version: policy.version,
        approval_ref: options.approval_ref ?? policy.approval_ref ?? null,
        trigger_event_id: options.trigger_event_id ?? null,
        status: "gap",
        closure: null,
        considered: allConsidered,
        gap_reason: this.store.state.candidates.length === 0
          ? "no_candidate_registered" : "no_qualified_candidate",
        created_at: new Date().toISOString(),
      };
      this.store.state.substitutions.push(record);
    }
    this.store.state.log_version += 1;
    this.store.save();
    return record;
  }

  /**
   * 到期处理：替代窗口结束但原采点仍缺货时，按当日规则版本重选候选；
   * 已恢复的点不处理。重选产生新决定，旧决定保留为 closed/expired，链不可环。
   */
  processDueSubstitutions(today) {
    // 跨多天恢复时一次重放到位：反复处理到期决定，直到没有新到期为止。
    let changed = false;
    for (let guard = 0; guard < MAX_CHAIN_DEPTH; guard += 1) {
      let passChanged = false;
      for (const sub of this.store.state.substitutions) {
        if (sub.status !== "active" || sub.valid_to === null) continue;
        if (sub.valid_to >= today) continue;
        if (this.pointStatusAt(sub.failed_point_id, today) === "available") {
          sub.status = "closed";
          sub.closure = {reason: "expired_with_point_available", date: today};
          passChanged = true;
          continue;
        }
        sub.status = "closed";
        sub.closure = {reason: "expired", date: today};
        this._ensureSubstitution(sub.failed_point_id, this._nextDate(sub.valid_to));
        passChanged = true;
      }
      if (!passChanged) break;
      changed = true;
    }
    if (changed) this.store.save();
  }

  _nextDate(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  _schedule(task) {
    const record = {task_id: newId("task"), status: "pending", created_at: new Date().toISOString(), ...task};
    this.store.state.scheduled_tasks.push(record);
    return record;
  }

  // ---------------- 采用价解析（任一观察时刻） ----------------

  _latestOwnQuote(pointId, date) {
    const quotes = this._eventsOfPoint(pointId)
      .filter((e) => e.event_type === "quoted" || (e.event_type === "quality_change" && e.price !== undefined))
      .filter((e) => observationDateOf(e, this.timezone) <= date);
    return quotes[quotes.length - 1] || null;
  }

  /**
   * 解析某采点在某日实际进入指数的价格与完整路径。
   * options.policyVersion：重算口径。给出时不读取已固化替代决定，
   * 而是按该版本对当日失效重新做假设性选择（决定本身不写库）。
   * 返回 adopted（null 表示缺口）、path（逐步替代链）、gap_reason、policy_version。
   */
  resolveAdoption(pointId, date, trace = [], options = {}) {
    if (trace.some((step) => step.point_id === pointId) || trace.length > MAX_CHAIN_DEPTH) {
      return {
        adopted: null, price: null, currency: null, point_id: pointId, date,
        status: "gap", gap_reason: "substitution_cycle_detected", path: trace,
      };
    }
    const status = this.pointStatusAt(pointId, date);
    const quote = this._latestOwnQuote(pointId, date);
    if (status === "available") {
      // 若最近发生过恢复，恢复当日起必须有新报价，否则宁留缺口也不沿用缺货前旧价。
      const lastRestore = this._eventsOfPoint(pointId)
        .filter((e) => e.event_type === "restored" && observationDateOf(e, this.timezone) <= date)
        .pop();
      const freshEnough = !lastRestore
        || (quote && observationDateOf(quote, this.timezone) >= observationDateOf(lastRestore, this.timezone));
      const step = {
        point_id: pointId, status: "own_quote",
        event_id: freshEnough ? quote?.event_id ?? null : null,
        price: freshEnough ? quote?.price ?? null : null,
        currency: freshEnough ? quote?.currency ?? null : null, date,
      };
      return {
        adopted: freshEnough && quote ? pointId : null,
        price: freshEnough ? quote?.price ?? null : null,
        currency: freshEnough ? quote?.currency ?? null : null,
        status: freshEnough && quote ? "adopted" : "gap",
        gap_reason: freshEnough && quote ? null : (lastRestore ? "awaiting_post_restore_quote" : "no_quote_yet"),
        path: [...trace, step], policy_version: null,
      };
    }

    const sub = this._activeSubstitution(pointId, date)
      ?? this.store.state.substitutions
        .filter((s) => s.failed_point_id === pointId && s.valid_from <= date
          && (s.valid_to === null || s.valid_to >= date))
        .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]
      ?? null;

    const step = {
      point_id: pointId, status: "unavailable",
      substitution_id: sub?.substitution_id ?? null,
      policy_version: sub?.policy_version ?? null, date,
    };

    // 更正重算口径：按指定规则版本假设性重评，已固化决定只读不改。
    if (options.policyVersion) {
      return this._resolveHypothetical(pointId, date, trace, step, options);
    }

    if (!sub || sub.status === "gap" || !sub.replacement_point_id) {
      return {
        adopted: null, price: null, currency: null, status: "gap",
        gap_reason: sub?.gap_reason || "no_qualified_candidate",
        path: [...trace, {...step, reason: sub?.gap_reason || "no_qualified_candidate"}],
        policy_version: sub?.policy_version ?? null,
        considered: sub?.considered ?? [],
      };
    }
    const next = this.resolveAdoption(sub.replacement_point_id, date, [...trace, step]);
    return {...next, policy_version: sub.policy_version, substitution_id: sub.substitution_id};
  }

  /**
   * 更正口径：不读已固化决定，按给定规则版本对当日失效重新假设性选择。
   * 沿假设链递归，访问过的点一律排除，保证假设路径同样不成环。结果不写库。
   */
  _resolveHypothetical(pointId, date, trace, step, options) {
    const policy = this.store.state.policies.find((p) => p.version === options.policyVersion)
      ?? selectPolicy(this.store.state.policies, date);
    const context = this._substitutionContext(pointId, date);
    const forbidden = new Set(trace.map((s) => s.point_id));
    forbidden.add(pointId);
    const pool = this.store.state.candidates;
    const excluded = pool
      .filter((c) => forbidden.has(c.point_id))
      .map((c) => ({
        candidate_id: c.candidate_id, point_id: c.point_id, quality_grade: c.quality_grade,
        valid_from: c.valid_from ?? null, valid_to: c.valid_to ?? null,
        quality_delta: null, eligible: false, selected: false,
        reasons: ["excluded_to_prevent_substitution_cycle"],
      }));
    const {selected, considered} = chooseCandidates(
      pool.filter((c) => !forbidden.has(c.point_id)), context, policy,
    );
    const allConsidered = [...excluded, ...considered];
    const hypStep = {...step, policy_version: policy.version, hypothetical: true, considered: allConsidered};

    if (!selected) {
      return {
        adopted: null, price: null, currency: null, status: "gap",
        gap_reason: allConsidered.length === 0 ? "no_candidate_registered" : "no_qualified_candidate",
        path: [...trace, hypStep], policy_version: policy.version, considered: allConsidered,
      };
    }
    const next = this.resolveAdoption(selected.point_id, date, [...trace, hypStep], options);
    return {...next, policy_version: policy.version, hypothetical: true};
  }

  // ---------------- 重启恢复 ----------------

  resumeOnStartup(today) {
    // 1. 继续隔离处理：开放中的隔离条目保持 open，由接口暴露催办。
    const openQuarantine = this.listQuarantine("open").length;
    // 2. 到期替代：统一按今日重放到期决策（幂等）。
    this.processDueSubstitutions(today);
    // 3. 重算任务：未完成的任务交回指数服务（返回任务清单）。
    const pendingRecompute = this.store.state.recompute_tasks.filter((t) => t.status === "pending");
    for (const task of this.store.state.scheduled_tasks) {
      if (task.status === "pending" && task.run_at <= today && task.type === "substitution_expiry") {
        task.status = "done";
      }
    }
    this.store.save();
    return {open_quarantine: openQuarantine, pending_recompute: pendingRecompute};
  }
}
