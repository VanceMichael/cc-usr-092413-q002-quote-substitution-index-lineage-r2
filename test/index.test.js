import test from "node:test";
import assert from "node:assert/strict";
import {FileStore} from "../src/file-store.js";
import {LedgerService} from "../src/ledger.js";
import {IndexService, periodKey} from "../src/index.js";
import {quote, tempContext} from "./helpers.js";

function setup() {
  const store = new FileStore(tempContext().dir);
  const ledger = new LedgerService(store);
  const index = new IndexService(store, ledger);
  for (const id of ["point-a", "point-b"]) {
    ledger.registerPoint({point_id: id, product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  }
  return {store, ledger, index};
}

const ev = (overrides) => quote({
  point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x",
  ...overrides,
});

test("缺口不沿用过期价：指数只计可用采点并列出 gaps 与覆盖率", () => {
  const {ledger, index} = setup();
  // 只有跨地区候选，不合格 → 缺口而非沿用旧价。
  ledger.registerCandidate({candidate_id: "cand-z", point_id: "point-b", product_sku: "sku-1", region: "R9", store_tier: "tier-x", quality_grade: "standard"});
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(ev({
    event_id: "ua", source_seq: 5, event_type: "unavailable", price: undefined,
    observed_at: "2026-08-20T09:00:00+08:00",
  }));
  const result = index.computeIndex("sku-1", "R1", "2026-08-21");
  assert.equal(result.value, null);
  assert.deepEqual(result.coverage, {priced: 0, total: 2});
  assert.equal(result.gaps.find((g) => g.point_id === "point-a").reason, "no_qualified_candidate");
});

test("发布快照冻结：迟到的缺货/恢复不改变已发布观察值", () => {
  const {ledger, index} = setup();
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(ev({event_id: "qb", point_id: "point-b", observed_at: "2026-08-10T10:00:00+08:00", price: 40}));
  const key = periodKey("sku-1", "R1", "2026-08");
  index.openPeriod("sku-1", "R1", "2026-08");
  index.publishPeriod(key, "approval:P-1", "2026-08-31");
  const frozen = index.getPeriod(key).published.value;
  assert.equal(frozen, 20); // sqrt(10*40)

  // 次月迟到事件：缺货后恢复，不能反向改写 8 月。
  ledger.ingest(ev({
    event_id: "ua-sep", source_seq: 9, event_type: "unavailable", price: undefined,
    observed_at: "2026-09-02T09:00:00+08:00",
  }));
  ledger.ingest(ev({
    event_id: "ra-sep", source_seq: 10, event_type: "restored", price: undefined,
    observed_at: "2026-09-03T09:00:00+08:00",
  }));
  ledger.ingest(ev({event_id: "qa2", source_seq: 11, observed_at: "2026-09-03T10:00:00+08:00", price: 999}));

  const period = index.getPeriod(key);
  assert.equal(period.published.value, frozen);
  assert.equal(period.revisions.length, 0);
  assert.equal(period.published.snapshot.length, 2);
  assert.equal(period.published.approval_ref, "approval:P-1");
});

test("规则更正默认只重算开放期间，已发布期间跳过且不改写", () => {
  const {ledger, index, store} = setup();
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(ev({event_id: "qb", point_id: "point-b", observed_at: "2026-08-10T10:00:00+08:00", price: 40}));
  const aug = periodKey("sku-1", "R1", "2026-08");
  index.openPeriod("sku-1", "R1", "2026-08");
  index.publishPeriod(aug, "approval:P-1", "2026-08-31");
  const sepPeriod = index.openPeriod("sku-1", "R1", "2026-09");
  ledger.registerPolicy({version: "quote-substitution-2", effective_from: "2026-09-01", maximum_quality_delta: 0});

  const correction = index.registerCorrection({
    policy_version: "quote-substitution-2", approval_ref: "approval:C-9", reason: "收紧质量差",
  });
  const actions = Object.fromEntries(correction.affected_periods.map((a) => [a.period_key, a.action]));
  assert.equal(actions[aug], "skipped_published");
  assert.equal(actions[sepPeriod.key], "recomputed");
  assert.equal(index.getPeriod(aug).published.value, 20);
  assert.equal(index.getPeriod(aug).revisions.length, 0);
  assert.notEqual(index.getPeriod(sepPeriod.key).draft, null);
  assert.equal(store.state.recompute_tasks.at(-1).reason.startsWith("correction:"), true);
});

test("已发布期间在审批下留痕修订：旧值/新值/差异/批准关系齐全，冻结值不变", () => {
  const {ledger, index} = setup();
  // point-c 只作为替代采点存在，不计入一篮子（篮子仅 a、b）。
  ledger.registerCandidate({candidate_id: "cand-c", point_id: "point-c", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "premium"});
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(ev({event_id: "qb", point_id: "point-b", observed_at: "2026-08-10T10:00:00+08:00", price: 40}));
  ledger.ingest(ev({
    event_id: "qc", point_id: "point-c", quality_grade: "premium",
    observed_at: "2026-08-10T10:00:00+08:00", price: 90,
  }));
  ledger.ingest(ev({
    event_id: "ua", source_seq: 5, event_type: "unavailable", price: undefined,
    observed_at: "2026-08-20T09:00:00+08:00",
  }));
  const key = periodKey("sku-1", "R1", "2026-08");
  index.openPeriod("sku-1", "R1", "2026-08");
  index.publishPeriod(key, "approval:P-1", "2026-08-31");
  // v1 允许质量差 1：point-a 由 premium 的 point-c 替代 → sqrt(90*40)=60。
  assert.equal(index.getPeriod(key).published.value, 60);

  // 更正规则（v2 禁止质量差），并经审批对已发布期间留痕。
  ledger.registerPolicy({version: "quote-substitution-2", effective_from: "2026-08-01", maximum_quality_delta: 0});
  const correction = index.registerCorrection({
    policy_version: "quote-substitution-2", approval_ref: "approval:C-10",
    reason: "质量口径更正", scope: "published",
  });
  const period = index.getPeriod(key);
  assert.equal(period.published.value, 60, "冻结值不得改写");
  assert.equal(period.revisions.length, 1);
  const revision = period.revisions[0];
  assert.equal(revision.old_value, 60);
  assert.equal(revision.new_value, 40); // point-a 改判缺口，只剩 point-b
  assert.equal(revision.diff, -20);
  assert.equal(revision.original_approval_ref, "approval:P-1");
  assert.equal(revision.correction_approval_ref, "approval:C-10");
  assert.equal(correction.correction_id, revision.correction_id);
});

test("重算与迟到事件并发：栅栏阻止旧结果回写，重新取数后可提交", () => {
  const {ledger, index} = setup();
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-09-10T10:00:00+08:00", price: 10}));
  ledger.ingest(ev({event_id: "qb", point_id: "point-b", observed_at: "2026-09-10T10:00:00+08:00", price: 40}));
  const key = index.openPeriod("sku-1", "R1", "2026-09").key;
  const {task_id} = index.beginRecompute(key, "late-event-test");

  // 重算进行中迟到事件落盘，推进 log_version。
  ledger.ingest(ev({event_id: "qa2", source_seq: 8, observed_at: "2026-09-12T10:00:00+08:00", price: 16}));
  assert.throws(() => index.commitRecompute(task_id), (error) => {
    assert.equal(error.code, "stale_recompute_result");
    return true;
  });
  const staleTask = index.listRecomputeTasks().find((t) => t.task_id === task_id);
  assert.equal(staleTask.status, "rejected_stale");
  assert.equal(staleTask.fence_rejections, 1);
  // 开放期间草稿未被旧结果污染。
  assert.equal(index.getPeriod(key).draft, null);

  const again = index.runRecompute(key, "retry");
  assert.equal(again.task.status, "done");
  assert.equal(again.draft.value, 25.298221); // sqrt(16*40)
});

test("进程重启后未完成重算按新版本重新取数并完成", () => {
  const dir = tempContext().dir;
  let store = new FileStore(dir);
  let ledger = new LedgerService(store);
  let index = new IndexService(store, ledger);
  ledger.registerPoint({point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-09-10T10:00:00+08:00", price: 10}));
  const key = index.openPeriod("sku-1", "R1", "2026-09").key;
  index.beginRecompute(key, "will-survive-restart");

  // 重启：全新服务实例指向同一数据目录。
  store = new FileStore(dir);
  ledger = new LedgerService(store);
  index = new IndexService(store, ledger);
  const resumed = index.resumeRecompute();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].outcome, "done");
  assert.notEqual(index.getPeriod(key).draft, null);
});

test("trace 可按任一观察时刻还原原始事件、替代路径、采用规则与最终数值", () => {
  const {ledger, index, store} = setup();
  ledger.registerPoint({point_id: "point-c", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerCandidate({candidate_id: "cand-c", point_id: "point-c", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.ingest(ev({event_id: "qa", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(ev({event_id: "qc", point_id: "point-c", observed_at: "2026-08-11T10:00:00+08:00", price: 30}));
  ledger.ingest(ev({
    event_id: "ua", source_seq: 5, event_type: "unavailable", price: undefined,
    observed_at: "2026-08-20T09:00:00+08:00",
  }));

  const before = index.trace("point-a", "2026-08-19");
  assert.equal(before.adoption.price, 10);
  assert.equal(before.raw_events.length, 1);
  assert.equal(before.rule_in_effect.version, "quote-substitution-1");

  const after = index.trace("point-a", "2026-08-21");
  assert.equal(after.adoption.price, 30);
  assert.equal(after.adoption.adopted_point_id, "point-c");
  assert.equal(after.adoption.path.length, 2);
  assert.equal(after.substitution_path[0].replacement_point_id, "point-c");
  assert.equal(after.substitution_path[0].considered.length >= 1, true);
  assert.equal(after.substitution_path[0].policy_version, "quote-substitution-1");
  // 原始事件保留缺货与报价两类。
  assert.deepEqual(after.raw_events.map((e) => e.event_type).sort(), ["quoted", "unavailable"]);
  assert.equal(store.state.log_version > 0, true);
});
