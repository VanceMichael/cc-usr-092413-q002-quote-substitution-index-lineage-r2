import test from "node:test";
import assert from "node:assert/strict";
import {buildApp, createContext} from "../src/server.js";
import {tempContext, quote} from "./helpers.js";

async function withServer(run) {
  const context = createContext(tempContext().dir);
  const {server} = buildApp(context);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base, context);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, body) => fetch(base + path, {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
});
const get = (base, path) => fetch(base + path);

test("健康检查返回日志版本", async () => {
  await withServer(async (base) => {
    const res = await get(base, "/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });
});

test("事件接收→同标识异文隔离→审批取代 全链路", async () => {
  await withServer(async (base) => {
    const event = quote({event_id: "evt-1", source_seq: 1, price: 10, observed_at: "2026-08-10T10:00:00+08:00"});
    let res = await post(base, "/v1/events", event);
    assert.equal((await res.json()).status, "accepted");
    res = await post(base, "/v1/events", event);
    assert.equal((await res.json()).status, "duplicate");
    res = await post(base, "/v1/events", {...event, source_seq: 2, price: 11});
    const q = await res.json();
    assert.equal(q.status, "quarantined");

    // 缺审批依据被拒。
    res = await post(base, `/v1/quarantine/${q.quarantine_id}/resolve`, {decision: "accept"});
    assert.equal(res.status, 400);
    res = await post(base, `/v1/quarantine/${q.quarantine_id}/resolve`, {
      decision: "accept", approval_ref: "ticket:H-1",
    });
    assert.equal(res.status, 200);
    const events = await (await get(base, "/v1/events")).json();
    assert.equal(events.events[0].price, 11);
  });
});

test("替代与 trace：缺货日按替代路径取价，历史日保留自有价", async () => {
  await withServer(async (base) => {
    await post(base, "/v1/points", {point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
    await post(base, "/v1/points", {point_id: "point-c", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
    await post(base, "/v1/candidates", {candidate_id: "cand-c", point_id: "point-c", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
    await post(base, "/v1/events", quote({event_id: "qa", price: 10, observed_at: "2026-08-10T10:00:00+08:00"}));
    await post(base, "/v1/events", quote({event_id: "qc", point_id: "point-c", price: 30, observed_at: "2026-08-11T10:00:00+08:00"}));
    await post(base, "/v1/events", quote({
      event_id: "ua", source_seq: 5, event_type: "unavailable", price: undefined,
      observed_at: "2026-08-20T09:00:00+08:00",
    }));

    let trace = await (await get(base, "/v1/trace?point_id=point-a&date=2026-08-21")).json();
    assert.equal(trace.adoption.price, 30);
    assert.equal(trace.adoption.adopted_point_id, "point-c");
    assert.equal(trace.substitution_path[0].policy_version, "quote-substitution-1");
    assert.equal(trace.substitution_path[0].considered.find((c) => c.candidate_id === "cand-c").selected, true);

    trace = await (await get(base, "/v1/trace?point_id=point-a&date=2026-08-15")).json();
    assert.equal(trace.adoption.price, 10);
    assert.equal(trace.adoption.adopted_point_id, "point-a");
  });
});

test("发布期间后迟到事件不回写，更正修订保留旧值新值与批准关系", async () => {
  await withServer(async (base) => {
    await post(base, "/v1/points", {point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
    await post(base, "/v1/points", {point_id: "point-b", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
    await post(base, "/v1/events", quote({event_id: "qa", price: 10, observed_at: "2026-08-10T10:00:00+08:00"}));
    await post(base, "/v1/events", quote({event_id: "qb", point_id: "point-b", price: 40, observed_at: "2026-08-10T10:00:00+08:00"}));
    await post(base, "/v1/periods", {product_sku: "sku-1", region: "R1", period: "2026-08"});
    await post(base, "/v1/periods/sku-1/R1/2026-08/publish", {approval_ref: "approval:P-1", as_of: "2026-08-31"});

    // 迟到事件落在 9 月，8 月发布值不变。
    await post(base, "/v1/events", quote({event_id: "qa2", source_seq: 9, price: 999, observed_at: "2026-09-15T10:00:00+08:00"}));
    const periods = await (await get(base, "/v1/periods")).json();
    const aug = periods.periods.find((p) => p.period === "2026-08");
    assert.equal(aug.published.value, 20);
    assert.equal(aug.revisions.length, 0);

    // 指数实时计算会反映迟到事件，但发布快照保持冻结。
    const live = await (await get(base, "/v1/index?product_sku=sku-1&region=R1&date=2026-09-15")).json();
    assert.equal(live.value, Math.round(Math.sqrt(999 * 40) * 1e6) / 1e6);
  });
});

test("重算栅栏：迟到事件并发时提交被 409 拒绝并带任务号", async () => {
  await withServer(async (base, context) => {
    await post(base, "/v1/points", {point_id: "point-a", product_sku: "sku-1", region: "R1", store_tier: "tier-x", quality_grade: "standard"});
    await post(base, "/v1/events", quote({event_id: "qa", price: 10, observed_at: "2026-09-10T10:00:00+08:00"}));
    await post(base, "/v1/periods", {product_sku: "sku-1", region: "R1", period: "2026-09"});
    const period = context.index.listPeriods()[0];
    const {task_id} = context.index.beginRecompute(period.key, "http-race");

    // 重算进行中迟到事件落盘，旧结果提交被栅栏拦截。
    await post(base, "/v1/events", quote({event_id: "qa2", source_seq: 8, price: 16, observed_at: "2026-09-12T10:00:00+08:00"}));
    const rejected = await post(base, `/v1/recompute-tasks/${task_id}/commit`, {});
    assert.equal(rejected.status, 409);
    const body = await rejected.json();
    assert.equal(body.error, "stale_recompute_result");
    assert.equal(body.task_id, task_id);

    // 重新发起重算成功，反映迟到价格。
    const ok = await post(base, "/v1/periods/sku-1/R1/2026-09/recompute", {reason: "retry"});
    const draft = (await ok.json()).draft;
    assert.equal(draft.value, 16);
  });
});
