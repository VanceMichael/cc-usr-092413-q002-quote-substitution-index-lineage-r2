import {selectPolicy} from "./policy.js";
import {observationDateOf} from "./quote-event.js";

/**
 * 指数回溯服务。
 * 不变量：
 * 1. 期间一旦发布，观察值快照冻结；跨日恢复、迟到事件只影响开放期间。
 * 2. 规则更正自动重算开放期间；已发布期间不改写，只追加留痕修订
 *    （旧值/新值/差异/原批准与更正批准关系）。
 * 3. 重算走 log_version 栅栏：开始时取版本，提交时若版本已变（迟到事件写入），
 *    旧结果拒绝回写。
 */

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function periodKey(productSku, region, period) {
  return `${productSku}|${region}|${period}`;
}

function parseKey(key) {
  const [product_sku, region, period] = key.split("|");
  return {product_sku, region, period};
}

export class IndexService {
  constructor(store, ledger) {
    this.store = store;
    this.ledger = ledger;
  }

  _periods() {
    return this.store.state.periods;
  }

  openPeriod(productSku, region, period) {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new TypeError("period 必须是 YYYY-MM");
    }
    const key = periodKey(productSku, region, period);
    const existing = this._periods()[key];
    if (existing && existing.status !== "open") {
      throw new Error("period_not_open");
    }
    if (!existing) {
      this._periods()[key] = {
        key, product_sku: productSku, region, period,
        status: "open", opened_at: new Date().toISOString(),
        draft: null, published: null, revisions: [],
      };
      this.store.state.log_version += 1;
      this.store.save();
    }
    return this._periods()[key];
  }

  getPeriod(key) {
    return this._periods()[key] || null;
  }

  listPeriods() {
    return Object.values(this._periods());
  }

  _basketPoints(productSku, region) {
    return Object.values(this.store.state.points)
      .filter((p) => p.product_sku === productSku && p.region === region)
      .map((p) => p.point_id)
      .sort();
  }

  /**
   * 计算某日一篮子采点的指数（采用价的几何平均）。
   * 缺口采点不沿用过期价格，单列在 gaps 中；全部缺口时指数为 null。
   */
  computeIndex(productSku, region, date, options = {}) {
    const policy = selectPolicy(this.store.state.policies, date);
    const pointIds = options.point_ids ?? this._basketPoints(productSku, region);
    const resolveOptions = options.policy_version ? {policyVersion: options.policy_version} : {};
    const entries = pointIds.map((pointId) => this.ledger.resolveAdoption(pointId, date, [], resolveOptions));
    const priced = entries.filter((e) => typeof e.price === "number");
    const gaps = entries
      .filter((e) => typeof e.price !== "number")
      .map((e) => ({point_id: e.path?.[0]?.point_id ?? e.point_id, reason: e.gap_reason || "gap"}));
    let value = null;
    if (priced.length > 0) {
      const logMean = priced.reduce((sum, e) => sum + Math.log(e.price), 0) / priced.length;
      value = Number(Math.exp(logMean).toFixed(6));
    }
    return {
      product_sku: productSku, region, date,
      policy_version: options.policy_version ?? policy.version,
      value,
      currency: priced[0]?.currency ?? null,
      coverage: {priced: priced.length, total: entries.length},
      gaps,
      entries: entries.map((e) => ({
        point_id: e.path?.[0]?.point_id ?? e.point_id,
        adopted_point_id: e.adopted,
        price: e.price,
        status: e.status,
        substitution_id: e.substitution_id ?? null,
        path: e.path,
      })),
      computed_at: new Date().toISOString(),
      log_version: this.store.state.log_version,
    };
  }

  // ---------------- 发布与冻结 ----------------

  publishPeriod(key, approvalRef, asOf = null) {
    if (!approvalRef || typeof approvalRef !== "string") {
      throw new Error("approval_required");
    }
    const period = this._periods()[key];
    if (!period) throw new Error("period_not_found");
    const date = asOf ?? this._defaultAsOf(period.period);
    const computed = this.computeIndex(period.product_sku, period.region, date);
    // 发布即冻结：快照连同事件编号、替代路径、规则版本一起固化。
    period.status = "published";
    period.published = {
      value: computed.value,
      currency: computed.currency,
      date,
      snapshot: computed.entries,
      policy_versions: [...new Set(computed.entries.map((e) => this._policyOfEntry(e)).filter(Boolean))],
      approval_ref: approvalRef,
      approved_at: new Date().toISOString(),
      log_version: this.store.state.log_version,
    };
    this.store.state.log_version += 1;
    this.store.save();
    return period;
  }

  _policyOfEntry(entry) {
    const sub = this.store.state.substitutions.find((s) => s.substitution_id === entry.substitution_id);
    return sub?.policy_version ?? null;
  }

  _defaultAsOf(period) {
    const [year, month] = period.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  // ---------------- 重算（带栅栏） ----------------

  beginRecompute(key, reason = "manual") {
    const period = this._periods()[key];
    if (!period) throw new Error("period_not_found");
    if (period.status !== "open") throw new Error("period_not_open");
    const task = {
      task_id: newId("recompute"),
      period_key: key,
      reason,
      status: "pending",
      base_log_version: this.store.state.log_version,
      requested_at: new Date().toISOString(),
      finished_at: null,
      result: null,
      fence_rejections: 0,
    };
    this.store.state.recompute_tasks.push(task);
    this.store.save();
    return {task_id: task.task_id, log_version: task.base_log_version};
  }

  /**
   * 提交重算结果。提交时的当前 log_version 必须等于开始时的版本，
   * 否则说明期间有迟到事件/主数据写入，结果一律拒绝，调用方需重新取数。
   */
  commitRecompute(taskId) {
    const task = this.store.state.recompute_tasks.find((t) => t.task_id === taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "pending") throw new Error("task_not_pending");
    const period = this._periods()[task.period_key];
    if (!period || period.status !== "open") {
      task.status = "abandoned";
      task.finished_at = new Date().toISOString();
      this.store.save();
      throw new Error("period_no_longer_open");
    }
    if (task.base_log_version !== this.store.state.log_version) {
      task.status = "rejected_stale";
      task.fence_rejections += 1;
      task.finished_at = new Date().toISOString();
      this.store.state.log_version += 1;
      this.store.save();
      const error = new Error("stale_recompute_result");
      error.code = "stale_recompute_result";
      error.task_id = taskId;
      throw error;
    }
    const computed = this.computeIndex(period.product_sku, period.region, this._defaultAsOf(period.period));
    period.draft = computed;
    task.status = "done";
    task.result = {value: computed.value, log_version: computed.log_version};
    task.finished_at = new Date().toISOString();
    this.store.state.log_version += 1;
    this.store.save();
    return {task, draft: computed};
  }

  /** 同步重算：取栅栏后立即提交（单线程内无插入写入，必然成功）。 */
  runRecompute(key, reason = "manual") {
    const {task_id} = this.beginRecompute(key, reason);
    return this.commitRecompute(task_id);
  }

  // ---------------- 规则更正 ----------------

  /**
   * 登记规则更正并处理其影响：
   * - scope=open（默认）：只对开放期间重算，已发布期间不动；
   * - scope=published 且带审批：已发布期间追加修订留痕，冻结值不改写。
   */
  registerCorrection(input) {
    const required = ["policy_version", "approval_ref", "reason"];
    for (const key of required) {
      if (typeof input[key] !== "string" || input[key].trim() === "") {
        throw new Error(`${key}_required`);
      }
    }
    const policy = this.store.state.policies.find((p) => p.version === input.policy_version);
    if (!policy) throw new Error("policy_version_not_found");
    const correction = {
      correction_id: newId("corr"),
      policy_version: input.policy_version,
      effective_from: policy.effective_from,
      reason: input.reason,
      approval_ref: input.approval_ref,
      scope: input.scope ?? "open",
      created_at: new Date().toISOString(),
      affected_periods: [],
    };

    for (const period of this.listPeriods()) {
      if (period.status === "open") {
        const {task} = this.runRecompute(period.key, `correction:${correction.correction_id}`);
        correction.affected_periods.push({period_key: period.key, action: "recomputed", task_id: task.task_id});
      } else if (period.status === "published" && correction.scope === "published") {
        // 用更正后的规则版本对冻结当日做假设性重算（替代决定本身只读不改）。
        const recomputed = this.computeIndex(
          period.product_sku, period.region, period.published.date,
          {policy_version: input.policy_version},
        );
        const oldValue = period.published.value;
        const newValue = recomputed.value;
        const revision = {
          revision_id: newId("rev"),
          correction_id: correction.correction_id,
          policy_version: input.policy_version,
          old_value: oldValue,
          new_value: newValue,
          diff: oldValue !== null && newValue !== null ? Number((newValue - oldValue).toFixed(6)) : null,
          diff_ratio: oldValue ? Number(((newValue - oldValue) / oldValue).toFixed(6)) : null,
          // 批准关系：原发布批准与本次更正批准同时保留。
          original_approval_ref: period.published.approval_ref,
          correction_approval_ref: input.approval_ref,
          recomputed_snapshot: recomputed.entries,
          created_at: new Date().toISOString(),
          status: "recorded_frozen_value_unchanged",
        };
        period.revisions.push(revision);
        correction.affected_periods.push({
          period_key: period.key, action: "revision_recorded", revision_id: revision.revision_id,
        });
      }
      // 其余已发布期间：只登记更正事实，不触碰旧值。
      if (period.status === "published" && correction.scope === "open") {
        correction.affected_periods.push({period_key: period.key, action: "skipped_published"});
      }
    }

    this.store.state.corrections.push(correction);
    this.store.state.log_version += 1;
    this.store.save();
    return correction;
  }

  listCorrections() {
    return this.store.state.corrections;
  }

  listRecomputeTasks() {
    return this.store.state.recompute_tasks;
  }

  // ---------------- 重启后继续重算 ----------------

  resumeRecompute() {
    const resumed = [];
    for (const task of this.store.state.recompute_tasks) {
      if (task.status !== "pending") continue;
      const period = this._periods()[task.period_key];
      if (!period || period.status !== "open") {
        task.status = "abandoned";
        task.finished_at = new Date().toISOString();
        resumed.push({task_id: task.task_id, outcome: "abandoned"});
        continue;
      }
      // 重启后栅栏基于当前版本重新取数，避免用重启前的旧结果回写。
      task.base_log_version = this.store.state.log_version;
      const {task: finished} = this.commitRecompute(task.task_id);
      resumed.push({task_id: task.task_id, outcome: finished.status});
    }
    if (resumed.length > 0) this.store.save();
    return resumed;
  }

  // ---------------- 任一观察时刻还原 ----------------

  trace(pointId, date) {
    const tz = this.ledger.timezone;
    const rawEvents = this.ledger._eventsOfPoint(pointId)
      .filter((e) => observationDateOf(e, tz) <= date)
      .map((e) => ({
        event_id: e.event_id, source_seq: e.source_seq, event_type: e.event_type,
        observed_at: e.observed_at, price: e.price ?? null, quality_grade: e.quality_grade,
        new_quality_grade: e.new_quality_grade ?? null,
      }));
    const adoption = this.ledger.resolveAdoption(pointId, date);
    const policy = selectPolicy(this.store.state.policies, date);
    const chainIds = new Set((adoption.path || []).map((s) => s.substitution_id).filter(Boolean));
    const substitutionPath = [...chainIds].map((id) => {
      const s = this.store.state.substitutions.find((x) => x.substitution_id === id);
      return {
        substitution_id: s.substitution_id, status: s.status,
        failed_point_id: s.failed_point_id, replacement_point_id: s.replacement_point_id,
        valid_from: s.valid_from, valid_to: s.valid_to, policy_version: s.policy_version,
        quality_delta: s.quality_delta, approval_ref: s.approval_ref,
        considered: s.considered,
      };
    });
    return {
      point_id: pointId, date,
      raw_events: rawEvents,
      adoption: {
        status: adoption.status, price: adoption.price, currency: adoption.currency,
        adopted_point_id: adoption.adopted, gap_reason: adoption.gap_reason ?? null,
        path: adoption.path, policy_version: adoption.policy_version ?? policy.version,
      },
      substitution_path: substitutionPath,
      rule_in_effect: {version: policy.version, maximum_quality_delta: policy.maximum_quality_delta},
    };
  }
}

export {periodKey, parseKey};
