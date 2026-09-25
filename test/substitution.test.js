import test from "node:test";
import assert from "node:assert/strict";
import {FileStore} from "../src/file-store.js";
import {LedgerService} from "../src/ledger.js";
import {quote, tempContext} from "./helpers.js";

function setup() {
  const store = new FileStore(tempContext().dir);
  const ledger = new LedgerService(store);
  for (const id of ["point-a", "point-b", "point-d"]) {
    ledger.registerPoint({point_id: id, product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  }
  ledger.registerPoint({point_id: "point-c", product_sku: "sku-1", region: "R2", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerPoint({point_id: "point-e", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "premium"});
  ledger.registerCandidate({candidate_id: "cand-b", point_id: "point-b", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard", priority: 10});
  ledger.registerCandidate({candidate_id: "cand-c", point_id: "point-c", product_sku: "sku-1", region: "R2", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerCandidate({candidate_id: "cand-d", point_id: "point-d", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard", priority: 20});
  ledger.registerCandidate({candidate_id: "cand-e", point_id: "point-e", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "premium", priority: 30});
  return {store, ledger};
}

const unavailable = (point_id, date, seq) => quote({
  event_id: `evt-u-${point_id}-${date}`, source_seq: seq ?? 10, event_type: "unavailable",
  point_id, observed_at: `${date}T09:00:00+08:00`, price: undefined,
});

test("缺货触发替代决定，固定规格/地区/层级/质量/区间/审批与规则版本", () => {
  const {store, ledger} = setup();
  ledger.ingest(quote({event_id: "qb", point_id: "point-b", observed_at: "2026-08-05T10:00:00+08:00", price: 12}));
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));

  const sub = store.state.substitutions.find((s) => s.failed_point_id === "point-a");
  assert.equal(sub.status, "active");
  assert.equal(sub.replacement_point_id, "point-b");
  assert.equal(sub.product_sku, "sku-1");
  assert.equal(sub.region, "R1");
  assert.equal(sub.store_tier, "tier-x");
  assert.equal(sub.quality_grade_failed, "standard");
  assert.equal(sub.quality_grade_replacement, "standard");
  assert.equal(sub.quality_delta, 0);
  assert.equal(sub.valid_from, "2026-08-20");
  assert.equal(sub.valid_to, null);
  assert.equal(sub.policy_version, "quote-substitution-1");
  assert.equal(sub.approval_ref, "baseline:quote-substitution-1");
  assert.equal(sub.trigger_event_id, "evt-u-point-a-2026-08-20");

  const adoption = ledger.resolveAdoption("point-a", "2026-08-20");
  assert.equal(adoption.status, "adopted");
  assert.equal(adoption.adopted, "point-b");
  assert.equal(adoption.price, 12);
  assert.equal(adoption.path[0].status, "unavailable");
  assert.equal(adoption.path[1].point_id, "point-b");
});

test("未采用候选全部保留原因：地区不符、质量超差、排序落败", () => {
  const {store, ledger} = setup();
  ledger.ingest(quote({event_id: "qb", point_id: "point-b", observed_at: "2026-08-05T10:00:00+08:00", price: 12}));
  ledger.ingest(quote({event_id: "qd", point_id: "point-d", observed_at: "2026-08-05T10:00:00+08:00", price: 13}));
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));

  const sub = store.state.substitutions.find((s) => s.failed_point_id === "point-a");
  const byId = Object.fromEntries(sub.considered.map((c) => [c.candidate_id, c]));
  assert.equal(byId["cand-b"].selected, true);
  assert.deepEqual(byId["cand-c"].reasons, ["region_mismatch"]);
  assert.deepEqual(byId["cand-d"].reasons, ["lost_to_higher_ranked_candidate"]);
  assert.equal(byId["cand-e"].eligible, true);
  assert.equal(byId["cand-e"].quality_delta, 1);
});

test("替代链可多级延伸且不得成环：回到链上的点被排除并留缺口", () => {
  const {store, ledger} = setup();
  ledger.ingest(quote({event_id: "qb", point_id: "point-b", observed_at: "2026-08-05T10:00:00+08:00", price: 12}));
  ledger.ingest(quote({event_id: "qd", point_id: "point-d", observed_at: "2026-08-05T10:00:00+08:00", price: 14}));
  // 只给 point-d 准备一个回到 point-a 的候选，制造潜在环。
  ledger.registerCandidate({candidate_id: "cand-cycle", point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  // premium 候选不可用，保证唯一潜在路径是回到链上的点。
  ledger.registerCandidate({candidate_id: "cand-e", point_id: "point-e", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "premium", priority: 30, eligible: false});

  ledger.ingest(unavailable("point-a", "2026-08-20", 11));
  ledger.ingest(unavailable("point-b", "2026-08-20", 12));
  ledger.ingest(unavailable("point-d", "2026-08-20", 13));

  const adoption = ledger.resolveAdoption("point-a", "2026-08-20");
  assert.equal(adoption.price, null);
  assert.equal(adoption.status, "gap");
  const chain = adoption.path.map((s) => s.point_id);
  assert.deepEqual(chain, ["point-a", "point-b", "point-d"]);

  const dGap = store.state.substitutions.find((s) => s.failed_point_id === "point-d" && s.status === "gap");
  const cycle = dGap.considered.find((c) => c.candidate_id === "cand-cycle");
  assert.deepEqual(cycle.reasons, ["excluded_to_prevent_substitution_cycle"]);
  assert.equal(dGap.gap_reason, "no_qualified_candidate");
});

test("无合格候选保留缺口，绝不沿用过期价格", () => {
  const store = new FileStore(tempContext().dir);
  const ledger = new LedgerService(store);
  ledger.registerPoint({point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerPoint({point_id: "point-z", product_sku: "sku-1", region: "R2", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerCandidate({candidate_id: "cand-z", point_id: "point-z", product_sku: "sku-1", region: "R2", store_tier: "tier-x", quality_grade: "standard"});
  ledger.ingest(quote({event_id: "q1", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));

  assert.equal(ledger.resolveAdoption("point-a", "2026-08-18").price, 10);
  const after = ledger.resolveAdoption("point-a", "2026-08-20");
  assert.equal(after.price, null);
  assert.equal(after.gap_reason, "no_qualified_candidate");
});

test("跨日恢复不反向改写：替代窗口固定到恢复日前一天，恢复当日无新价即缺口", () => {
  const {store, ledger} = setup();
  ledger.ingest(quote({event_id: "qa", observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  ledger.ingest(quote({event_id: "qb", point_id: "point-b", observed_at: "2026-08-05T10:00:00+08:00", price: 12}));
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));
  ledger.ingest(quote({
    event_id: "evt-r-a", source_seq: 12, event_type: "restored", point_id: "point-a",
    observed_at: "2026-08-25T09:00:00+08:00",
  }));

  const sub = store.state.substitutions.find((s) => s.failed_point_id === "point-a");
  assert.equal(sub.status, "closed");
  assert.equal(sub.valid_to, "2026-08-24");
  // 历史观察日仍是替代价。
  assert.equal(ledger.resolveAdoption("point-a", "2026-08-24").price, 12);
  // 恢复当日没有新报价：缺口，不沿用旧价也不用替代。
  const restoreDay = ledger.resolveAdoption("point-a", "2026-08-25");
  assert.equal(restoreDay.price, null);
  assert.equal(restoreDay.gap_reason, "awaiting_post_restore_quote");
  // 新报价到位后采用自有价。
  ledger.ingest(quote({event_id: "qa2", source_seq: 13, observed_at: "2026-08-26T10:00:00+08:00", price: 11}));
  const again = ledger.resolveAdoption("point-a", "2026-08-26");
  assert.equal(again.price, 11);
  assert.equal(again.adopted, "point-a");
});

test("替代到期且原采点仍缺货时按当日规则版本重选，旧决定留痕", () => {
  const store = new FileStore(tempContext().dir);
  const ledger = new LedgerService(store);
  ledger.registerPoint({point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerPoint({point_id: "point-b", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerPoint({point_id: "point-d", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerCandidate({candidate_id: "cand-b", point_id: "point-b", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard", valid_to: "2026-08-22"});
  ledger.registerCandidate({candidate_id: "cand-d", point_id: "point-d", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.ingest(quote({event_id: "qb", point_id: "point-b", observed_at: "2026-08-05T10:00:00+08:00", price: 12}));
  ledger.ingest(quote({event_id: "qd", point_id: "point-d", observed_at: "2026-08-05T10:00:00+08:00", price: 14}));
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));

  assert.equal(ledger.resolveAdoption("point-a", "2026-08-22").adopted, "point-b");
  ledger.processDueSubstitutions("2026-08-23");
  assert.equal(ledger.resolveAdoption("point-a", "2026-08-22").adopted, "point-b");
  assert.equal(ledger.resolveAdoption("point-a", "2026-08-23").adopted, "point-d");
  const history = store.state.substitutions.filter((s) => s.failed_point_id === "point-a");
  assert.equal(history[0].status, "closed");
  assert.equal(history[0].closure.reason, "expired");
  assert.equal(history[1].status, "active");
});

test("规则版本按失效日选择：新版本生效前的决定仍用旧版本，质量超差被拒", () => {
  const store = new FileStore(tempContext().dir);
  const ledger = new LedgerService(store);
  ledger.registerPoint({point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerPoint({point_id: "point-e", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "premium"});
  ledger.registerCandidate({candidate_id: "cand-e", point_id: "point-e", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "premium"});
  // v2 从 9 月起禁止任何质量差。
  ledger.registerPolicy({version: "quote-substitution-2", effective_from: "2026-09-01", maximum_quality_delta: 0});

  ledger.ingest(unavailable("point-a", "2026-08-20", 11));
  const aug = store.state.substitutions.find((s) => s.failed_point_id === "point-a");
  assert.equal(aug.policy_version, "quote-substitution-1");
  assert.equal(aug.replacement_point_id, "point-e");

  ledger.ingest(quote({
    event_id: "evt-r-a", source_seq: 12, event_type: "restored", point_id: "point-a",
    observed_at: "2026-08-30T09:00:00+08:00",
  }));
  ledger.ingest(unavailable("point-a", "2026-09-05", 13));
  const sep = [...store.state.substitutions].reverse().find((s) => s.failed_point_id === "point-a");
  assert.equal(sep.policy_version, "quote-substitution-2");
  assert.equal(sep.status, "gap");
  assert.deepEqual(
    sep.considered.find((c) => c.candidate_id === "cand-e").reasons,
    ["quality_delta_exceeds_max"],
  );
});

test("质量变更后再缺货，替代评级按变更后的等级而非缺货事件携带的旧等级", () => {
  const {store, ledger} = setup();
  ledger.ingest(quote({
    event_id: "qch", source_seq: 4, event_type: "quality_change", new_quality_grade: "premium",
    observed_at: "2026-08-10T09:00:00+08:00", price: undefined,
  }));
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));
  const sub = store.state.substitutions.find((s) => s.failed_point_id === "point-a");
  assert.equal(sub.quality_grade_failed, "premium");
  // premium 的 point-e 现在质量差为 0，应胜过 standard 的 point-b。
  assert.equal(sub.replacement_point_id, "point-e");
  assert.equal(sub.quality_delta, 0);
});

test("缺口之后补登记合格候选，按指定观察日重估并补上替代", () => {
  const store = new FileStore(tempContext().dir);
  const ledger = new LedgerService(store);
  ledger.registerPoint({point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.registerPoint({point_id: "point-b", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  ledger.ingest(unavailable("point-a", "2026-08-20", 11));
  assert.equal(store.state.substitutions.at(-1).status, "gap");
  assert.equal(store.state.substitutions.at(-1).gap_reason, "no_candidate_registered");

  ledger.ingest(quote({event_id: "qb", point_id: "point-b", observed_at: "2026-08-05T10:00:00+08:00", price: 12}));
  ledger.registerCandidate({candidate_id: "cand-b", point_id: "point-b", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
  // 注册触发的重估以今日为准；历史日期的补评估显式指定。
  ledger.reevaluateGaps("2026-08-21");
  assert.equal(ledger.resolveAdoption("point-a", "2026-08-20").price, null);
  assert.equal(ledger.resolveAdoption("point-a", "2026-08-21").adopted, "point-b");
  const latest = store.state.substitutions.at(-1);
  assert.equal(latest.status, "active");
  assert.equal(latest.replacement_point_id, "point-b");
  assert.equal(latest.valid_from, "2026-08-21");
});
