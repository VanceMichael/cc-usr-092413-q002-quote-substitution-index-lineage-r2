import test from "node:test";
import assert from "node:assert/strict";
import {createApp} from "../src/server.js";
import {Store} from "../src/store.js";
import {DEFAULT_POLICY} from "../src/engine.js";

const TZ = "+08:00";
const T0 = Date.parse("2026-09-25T12:00:00+08:00");
const D1 = "2026-09-24";

async function startApp() {
  let now = T0;
  const app = await createApp({
    store: new Store(null),
    clock: () => now,
    policy: DEFAULT_POLICY,
    tickIntervalMs: 0, // 测试中只显式 tick，避免后台定时器干扰
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    ...app,
    base,
    setNow: (ms) => {
      now = ms;
    },
    req: async (method, urlPath, body) => {
      const res = await fetch(base + urlPath, {
        method,
        headers: body ? {"content-type": "application/json"} : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      return {status: res.status, body: json};
    },
  };
}

test("HTTP 端到端：采价→缺货→替代审批→指数发布→按时刻溯源", async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  for (const pid of ["p1", "p2"]) {
    const r = await app.req("POST", "/v1/points", {
      point_id: pid, product_id: "prod-1", region: "R1", store_level: "standard",
      spec: {size: "500g"}, quality_grade: "B",
    });
    assert.equal(r.status, 200);
  }

  assert.equal((await app.req("POST", "/v1/events", {
    event_id: "q1", source_seq: 1, point_id: "p1", event_type: "quoted",
    price: 10, observed_at: `${D1}T09:00:00${TZ}`,
  })).body.status, "accepted");
  assert.equal((await app.req("POST", "/v1/events", {
    event_id: "q2", source_seq: 2, point_id: "p2", event_type: "quoted",
    price: 20, observed_at: `${D1}T09:00:00${TZ}`,
  })).body.status, "accepted");
  // 幂等重放
  assert.equal((await app.req("POST", "/v1/events", {
    event_id: "q1", source_seq: 1, point_id: "p1", event_type: "quoted",
    price: 10, observed_at: `${D1}T09:00:00${TZ}`,
  })).body.status, "duplicate");
  // 异文隔离
  assert.equal((await app.req("POST", "/v1/events", {
    event_id: "q1", source_seq: 1, point_id: "p1", event_type: "quoted",
    price: 999, observed_at: `${D1}T09:00:00${TZ}`,
  })).body.status, "quarantined");

  const qlist = await app.req("GET", "/v1/quarantine");
  assert.equal(qlist.body.length, 1);
  assert.equal(qlist.body[0].reason, "content_conflict");
  // 拒绝隔离异文
  const resolved = await app.req("POST", "/v1/quarantine/q1/resolve", {action: "reject", by: "auditor"});
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, "rejected");

  // 缺货 → tick 评估
  assert.equal((await app.req("POST", "/v1/events", {
    event_id: "u1", source_seq: 5, point_id: "p1", event_type: "unavailable",
    observed_at: `${D1}T23:00:00${TZ}`,
  })).body.status, "accepted");
  await app.req("POST", "/v1/tasks/tick", {});

  const ev = await app.req("GET", `/v1/evaluations/eval-p1-${D1}`);
  assert.equal(ev.status, 200);
  assert.equal(ev.body.selected_point_id, "p2");
  const loser = ev.body.candidates.find((c) => c.point_id === "p2");
  assert.equal(loser.selected, true);

  // 审批缺依据 → 400
  const badApproval = await app.req("POST", `/v1/evaluations/eval-p1-${D1}/approve`, {});
  assert.equal(badApproval.status, 400);
  assert.equal(badApproval.body.error, "invalid_approval");

  const approval = await app.req("POST", `/v1/evaluations/eval-p1-${D1}/approve`, {
    by: "zhang", basis: "月末复核会议纪要 #12",
    valid_from_ms: Date.parse(`${D1}T23:00:00${TZ}`),
    valid_to_ms: Date.parse(`${D1}T23:00:00${TZ}`) + 86400000,
  });
  assert.equal(approval.status, 200);
  assert.deepEqual(approval.body.fixed, {spec: {size: "500g"}, region: "R1", store_level: "standard"});
  assert.equal(approval.body.candidate.quality_delta, 0);
  assert.equal(approval.body.approval.basis, "月末复核会议纪要 #12");

  // 重算并发布
  const key = "prod-1|R1|2026-09-24";
  const recomputed = await app.req("POST", "/v1/index/recompute", {key});
  assert.equal(recomputed.status, 200);
  assert.equal(recomputed.body.value, 20);
  const published = await app.req("POST", "/v1/index/publish", {key, by: "publisher-li"});
  assert.equal(published.body.status, "published");

  // 已发布期间重复发布 → 409
  const again = await app.req("POST", "/v1/index/publish", {key});
  assert.equal(again.status, 409);

  // 溯源：还原原始事件、替代路径、采用规则与指数值
  const trace = await app.req("GET", `/v1/trace?product_id=prod-1&region=R1&at_ms=${T0}`);
  assert.equal(trace.status, 200);
  const p1 = trace.body.points.find((p) => p.point_id === "p1");
  assert.equal(p1.events.length, 2);
  assert.equal(p1.adopted.price, 20);
  assert.deepEqual(p1.adopted.path, ["p1", "p2"]);
  assert.equal(p1.adopted.substitution.approval.basis, "月末复核会议纪要 #12");
  const idx = trace.body.indexes.find((i) => i.key === key);
  assert.equal(idx.status, "published");
  assert.equal(idx.adopted_value, 20);
  assert.equal(idx.rule_version, "quote-substitution-1");

  // 健康检查与 404
  assert.equal((await app.req("GET", "/health")).body.status, "ok");
  assert.equal((await app.req("GET", "/nope")).status, 404);
  // 非法 JSON
  const res = await fetch(app.base + "/v1/events", {method: "POST", body: "{not-json"});
  assert.equal(res.status, 400);
});
