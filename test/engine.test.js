import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {Store} from "../src/store.js";
import {PriceEngine, DEFAULT_POLICY} from "../src/engine.js";

const TZ = "+08:00";
const T0 = Date.parse("2026-09-25T12:00:00+08:00");
const D1 = "2026-09-24";
const D2 = "2026-09-25";

// 各用例内来源序号默认全局唯一，避免不同报价误用同一 source_id+seq 被隔离。
let seqCounter = 100;
test.beforeEach(() => {
  seqCounter = 100;
});

function makeEngine({now = T0, file = null, hooks} = {}) {
  let t = now;
  const clock = () => t;
  const store = new Store(file);
  const engine = new PriceEngine(store, DEFAULT_POLICY, clock, hooks);
  return {
    engine,
    store,
    clock,
    advance: (ms) => {
      t += ms;
      return t;
    },
    setNow: (ms) => {
      t = ms;
    },
  };
}

function event(partial) {
  return {
    event_id: partial.event_id,
    source_seq: partial.source_seq,
    source_id: partial.source_id ?? "src-1",
    point_id: partial.point_id,
    event_type: partial.event_type,
    observed_at: partial.observed_at,
    ...(partial.price !== undefined ? {price: partial.price} : {}),
    ...(partial.reason !== undefined ? {reason: partial.reason} : {}),
    ...(partial.quality_grade !== undefined ? {quality_grade: partial.quality_grade} : {}),
    ...(partial.extra ?? {}),
  };
}

const quote = (event_id, point_id, price, day, hour = 10, extra = {}) =>
  event({event_id, point_id, event_type: "quoted", price, observed_at: `${day}T${String(hour).padStart(2, "0")}:00:00${TZ}`, source_seq: extra.source_seq ?? (seqCounter += 1), ...extra});
const unavailable = (event_id, point_id, day, hour = 23, seq = 2) =>
  event({event_id, point_id, event_type: "unavailable", observed_at: `${day}T${String(hour).padStart(2, "0")}:00:00${TZ}`, source_seq: seq});
const restored = (event_id, point_id, day, hour = 9, seq = 3, price) =>
  event({event_id, point_id, event_type: "restored", observed_at: `${day}T${String(hour).padStart(2, "0")}:00:00${TZ}`, source_seq: seq, ...(price !== undefined ? {price} : {})});

async function seedPoint(engine, p) {
  await engine.upsertPoint({
    product_id: "prod-1",
    region: "R1",
    store_level: "standard",
    spec: {size: "500g"},
    quality_grade: "B",
    ...p,
  });
}

test("来源序号幂等：重复报文接收一次，同标识异文与序号冲突进入隔离", async () => {
  const {engine, store} = makeEngine();
  const q = quote("evt-1", "p1", 10, D2, 10, {source_seq: 1, extra: {product_id: "prod-1", region: "R1"}});
  assert.equal((await engine.ingest(q)).status, "accepted");
  assert.equal((await engine.ingest(q)).status, "duplicate");

  // 同一 event_id、不同内容（价格被改）→ 异文隔离
  const tampered = {...q, price: 11};
  const conflict = await engine.ingest(tampered);
  assert.equal(conflict.status, "quarantined");
  assert.equal(conflict.reason, "content_conflict");

  // 不同 event_id 复用来源序号 → 序号冲突隔离
  const seqClash = quote("evt-2", "p1", 12, D2, 10, {source_seq: 1});
  const clash = await engine.ingest(seqClash);
  assert.equal(clash.status, "quarantined");
  assert.equal(clash.reason, "source_seq_conflict");

  const qrec = store.snapshot().quarantine["evt-2"];
  assert.equal(qrec.status, "pending");

  // 更正为未占用序号后可从隔离放行
  const fixed = {...seqClash, source_seq: 99};
  const resolved = await engine.resolveQuarantine("evt-2", "accept", {correctedEvent: fixed});
  assert.equal(resolved.status, "accepted");
  assert.equal(store.snapshot().quarantine["evt-2"].status, "accepted");

  // 拒绝路径
  const rej = await engine.ingest({...q, event_id: "evt-3", price: 99});
  assert.equal(rej.status, "quarantined");
  await engine.resolveQuarantine("evt-3", "reject");
  assert.equal(store.snapshot().quarantine["evt-3"].status, "rejected");
  assert.equal(store.snapshot().events["evt-3"], undefined);
});

test("失效点位按规则版本选择候选并保存未采用原因；无合格候选保留缺口", async () => {
  const {engine, store} = makeEngine();
  await seedPoint(engine, {point_id: "p1"}); // 失效点
  await seedPoint(engine, {point_id: "p2", quality_grade: "B"}); // 同规格同地区
  await seedPoint(engine, {point_id: "p3", quality_grade: "A"}); // 同规格同地区，质量差异更大
  await seedPoint(engine, {point_id: "p4", quality_grade: "B", region_group: "G1"}); // p1 无 group → 不能用相邻地区
  // p1 自身归档 region R1 无 group，p4 设不同 region 以便落入选型
  await engine.upsertPoint({point_id: "p4", product_id: "prod-1", region: "R2", region_group: "G1", store_level: "standard", spec: {size: "500g"}, quality_grade: "B"});

  await engine.ingest(quote("e1", "p1", 10, D1, 9));
  await engine.ingest(quote("e2", "p2", 20, D1, 9));
  await engine.ingest(quote("e3", "p3", 30, D1, 9));
  await engine.ingest(quote("e4", "p4", 40, D1, 9));

  await engine.ingest(unavailable("e5", "p1", D1, 23, 5));
  await engine.tick(T0);

  const ev = store.snapshot().evaluations[`eval-p1-${D1}`];
  assert.equal(ev.policy_version, "quote-substitution-1");
  assert.equal(ev.selected_point_id, "p2");
  const p2 = ev.candidates.find((c) => c.point_id === "p2");
  assert.equal(p2.selected, true);
  assert.equal(p2.quality_delta, 0);
  const p3 = ev.candidates.find((c) => c.point_id === "p3");
  assert.equal(p3.eligible, true);
  assert.ok(p3.reasons.includes("ranked_lower"), "落选合格候选必须保留未采用原因");
  assert.equal(p3.quality_delta, 1);
  const p4 = ev.candidates.find((c) => c.point_id === "p4");
  assert.equal(p4.eligible, false);
  assert.ok(p4.reasons.includes("no_matching_selection_tier"));
  assert.equal(ev.status, "awaiting_approval");

  // 未批准前：失效点没有有效替代 → 缺口，不沿用旧价
  const key = engine.periodKey("prod-1", "R1", D1);
  const computed = engine.computePeriod(store.snapshot(), key, T0);
  const p1c = computed.contributions.find((c) => c.point_id === "p1");
  assert.equal(p1c.adopted, false);
  assert.equal(p1c.price, null);
  assert.equal(p1c.reason, "no_candidate");
});

test("过期报价不能充当候选：报价超龄的地区保留缺口", async () => {
  const {engine, store} = makeEngine();
  await seedPoint(engine, {point_id: "p1"});
  await seedPoint(engine, {point_id: "p2"});
  // p2 的报价在失效观察日 10 天前 → 超龄
  await engine.ingest(quote("e1", "p1", 10, D1, 9));
  await engine.ingest(quote("e2", "p2", 20, "2026-09-14", 9));
  await engine.ingest(unavailable("e3", "p1", D1, 23, 5));
  await engine.tick(T0);
  const ev = store.snapshot().evaluations[`eval-p1-${D1}`];
  assert.equal(ev.selected_point_id, null);
  assert.equal(ev.status, "no_candidate");
  assert.ok(ev.candidates.find((c) => c.point_id === "p2").reasons.includes("quote_too_old"));
  const resolved = engine.resolvePoint(store.snapshot(), "p1", Date.parse(`${D1}T23:30:00${TZ}`));
  assert.equal(resolved.gap, true);
  assert.equal(resolved.reason, "no_candidate");
});

test("替代决定固定规格/地区/层级/质量差异/有效区间/审批依据，且替代链不得成环或超长", async () => {
  const {engine, store} = makeEngine();
  for (const [pid, grade] of [["p1", "B"], ["p2", "B"], ["p3", "B"], ["p4", "B"]]) {
    await seedPoint(engine, {point_id: pid, quality_grade: grade});
  }
  for (const [i, pid] of ["p1", "p2", "p3", "p4"].entries()) {
    await engine.ingest(quote(`q${i}`, pid, 10 + i, D1, 9));
  }
  await engine.ingest(unavailable("u1", "p1", D1, 23, 5));
  await engine.tick(T0);

  // 审批依据必填、区间校验
  await assert.rejects(() => engine.approveSubstitution(`eval-p1-${D1}`, {}), /basis/);
  await assert.rejects(
    () => engine.approveSubstitution(`eval-p1-${D1}`, {
      basis: "x", validFromMs: 100, validToMs: 50,
    }),
    /区间/,
  );

  const from = Date.parse(`${D1}T23:00:00${TZ}`);
  const to = from + 3 * 24 * 3600 * 1000;
  const sub = await engine.approveSubstitution(`eval-p1-${D1}`, {
    by: "zhang",
    basis: "月度复核会议纪要 #12：同规格同地区 B 级门店临时补采",
    validFromMs: from,
    validToMs: to,
  });
  assert.deepEqual(sub.fixed, {spec: {size: "500g"}, region: "R1", store_level: "standard"});
  assert.equal(sub.candidate.point_id, "p2");
  assert.equal(sub.candidate.quality_delta, 0);
  assert.equal(sub.valid_from_ms, from);
  assert.equal(sub.valid_to_ms, to);
  assert.equal(sub.approval.approved_by, "zhang");

  // 档案事后变更不影响已固定的决定
  await engine.upsertPoint({point_id: "p1", product_id: "prod-1", region: "R9", store_level: "flagship", spec: {size: "1kg"}});
  const again = store.snapshot().substitutions[sub.sub_id];
  assert.equal(again.fixed.region, "R1");
  assert.equal(again.fixed.store_level, "standard");

  // p2 失效 → 用 p3
  await engine.ingest(unavailable("u2", "p2", D2, 8, 6));
  await engine.tick(T0);
  await engine.approveSubstitution(`eval-p2-${D2}`, {
    basis: "链第二层：p3 同规格补采",
    validFromMs: Date.parse(`${D2}T08:00:00${TZ}`),
    validToMs: to,
  });
  // p3 若再指向 p1 即成环 → 拒绝
  await engine.ingest(unavailable("u3", "p3", D2, 9, 7));
  await engine.tick(T0);
  await assert.rejects(
    () => engine.approveSubstitution(`eval-p3-${D2}`, {
      basis: "尝试回指 p1",
      validFromMs: Date.parse(`${D2}T09:00:00${TZ}`),
      validToMs: to,
      candidatePointId: "p1",
    }),
    /成环|链超过/,
  );
});

test("替代路径被采用价采用，且多层链路可递归解析", async () => {
  const {engine, store} = makeEngine();
  for (const pid of ["p1", "p2"]) await seedPoint(engine, {point_id: pid});
  await engine.ingest(quote("q1", "p1", 10, D1, 9));
  await engine.ingest(quote("q2", "p2", 22, D1, 9));
  await engine.ingest(unavailable("u1", "p1", D1, 23, 5));
  await engine.tick(T0);
  const from = Date.parse(`${D1}T23:00:00${TZ}`);
  await engine.approveSubstitution(`eval-p1-${D1}`, {basis: "补采单 #7", validFromMs: from, validToMs: from + 86400000});

  const at = Date.parse(`${D1}T23:30:00${TZ}`);
  const r = engine.resolvePoint(store.snapshot(), "p1", at);
  assert.equal(r.gap, undefined);
  assert.equal(r.price, 22);
  assert.equal(r.source_event_id, "q2");
  assert.equal(r.substituted_via.startsWith("sub-"), true);
  assert.deepEqual(r.path, ["p1", "p2"]);

  const key = engine.periodKey("prod-1", "R1", D1);
  const computed = engine.computePeriod(store.snapshot(), key, T0);
  assert.ok(Math.abs(computed.value - 22) < 1e-9);
  const c1 = computed.contributions.find((c) => c.point_id === "p1");
  assert.equal(c1.adopted, true);
  assert.equal(c1.substituted_via, r.substituted_via);
});

test("跨日恢复不能反向改写已发布观察值；到期后替代失效并保留缺口", async () => {
  const {engine, store, advance} = makeEngine();
  for (const pid of ["p1", "p2"]) await seedPoint(engine, {point_id: pid});
  await engine.ingest(quote("q1", "p1", 10, D1, 9));
  await engine.ingest(quote("q2", "p2", 20, D1, 9));
  await engine.ingest(unavailable("u1", "p1", D1, 23, 5));
  await engine.tick(T0);
  const from = Date.parse(`${D1}T23:00:00${TZ}`);
  const to = from + 2 * 3600 * 1000; // D2 01:00 到期
  await engine.approveSubstitution(`eval-p1-${D1}`, {basis: "夜间补采", validFromMs: from, validToMs: to});

  const key1 = engine.periodKey("prod-1", "R1", D1);
  await engine.recomputePeriod(key1);
  await engine.publishIndex(key1, {by: "publisher-li"});
  const published = store.snapshot().indexPeriods[key1];
  const v1 = published.values[published.values.length - 1].value;
  const pubVersion = published.published_version;
  assert.ok(pubVersion >= 1);

  // D2 凌晨替代到期：tick 后替代失效，缺口保留
  advance(2 * 3600 * 1000 + 1000);
  await engine.tick();
  assert.equal(store.snapshot().substitutions[Object.keys(store.snapshot().substitutions)[0]].status, "expired");
  const afterExpiry = engine.resolvePoint(store.snapshot(), "p1", to + 1000);
  assert.equal(afterExpiry.gap, true);

  // D2 上午恢复（带新价）：区间被关闭，但 D1 已发布值不变
  await engine.ingest(restored("r1", "p1", D2, 9, 9, 11));
  const againPublished = store.snapshot().indexPeriods[key1];
  assert.equal(againPublished.status, "published");
  assert.equal(againPublished.published_version, pubVersion);
  assert.equal(againPublished.values.find((v) => v.version === pubVersion).value, v1);
  const frozen = await engine.recomputePeriod(key1);
  assert.equal(frozen, "published_frozen");

  // D2 当天恢复后用回本点新价
  const back = engine.resolvePoint(store.snapshot(), "p1", Date.parse(`${D2}T10:00:00${TZ}`));
  assert.equal(back.price, 11);
  assert.equal(back.substituted_via, undefined);
});

test("规则更正只重算开放期间；已发布指数保留旧值、新值、差异与批准关系", async () => {
  const {engine, store} = makeEngine();
  for (const pid of ["p1", "p2"]) await seedPoint(engine, {point_id: pid});
  await engine.ingest(quote("q1", "p1", 10, D1, 9));
  await engine.ingest(quote("q2", "p2", 40, D1, 9));

  // 新规则版本：算术平均（与几何平均产生可验证差异）。
  // 先在 v1 下完成初算与发布，之后再登记 v2，确保更正前基线来自旧规则。
  await engine.registerPolicy({...DEFAULT_POLICY, version: DEFAULT_POLICY.version}, 0);

  const key1 = engine.periodKey("prod-1", "R1", D1);
  const key2 = engine.periodKey("prod-1", "R1", D2);
  await engine.recomputePeriod(key1);
  await engine.recomputePeriod(key2);
  await engine.publishIndex(key1);
  const geo = Math.sqrt(10 * 40); // 20
  assert.ok(Math.abs(store.snapshot().indexPeriods[key1].values[0].value - geo) < 1e-9);

  await engine.registerPolicy(
    {...DEFAULT_POLICY, version: "rule-v2", index: {aggregation: "arithmetic_mean", min_points_per_region: 1, open_period_days: 2}},
    T0,
  );

  const corr = await engine.createCorrection({
    policy_version: "rule-v2",
    product_id: "prod-1",
    region: "R1",
    from_day: D1,
    to_day: D2,
    reason: "聚合公式口径更正：几何平均改算术平均",
  });
  const approved = await engine.approveCorrection(corr.correction_id, {by: "auditor-wang", basis: "统计局口径文件 #88"});

  assert.equal(approved.status, "approved");
  assert.equal(approved.approval.approved_by, "auditor-wang");
  // D1 已发布：冻结旧值，登记新旧差异，不改写
  const frozen = approved.frozen_periods.find((f) => f.key === key1);
  assert.ok(Math.abs(frozen.old_value - geo) < 1e-9);
  assert.equal(frozen.would_be_value, 25);
  assert.ok(Math.abs(frozen.diff - 5) < 1e-9);
  const p1period = store.snapshot().indexPeriods[key1];
  assert.equal(p1period.status, "published");
  assert.equal(p1period.values.length, 1);
  // D2 开放：写入新版本，旧值新值差异齐全
  const change = approved.changes.find((c) => c.key === key2);
  assert.ok(Math.abs(change.old_value - geo) < 1e-9);
  assert.equal(change.new_value, 25);
  assert.equal(change.applied_version, 2);
  const p2period = store.snapshot().indexPeriods[key2];
  assert.equal(p2period.values.length, 2);
  assert.equal(p2period.rule_version, "rule-v2");
  assert.deepEqual(p2period.correction_ids, [corr.correction_id]);
});

test("重算与迟到事件并发：旧结果被阻止回写，随后重试采用最新事件", async () => {
  let fired = false;
  const {engine, store} = makeEngine({
    hooks: {
      // 模拟重算耗时期间有迟到报价进入（只注入一次）
      beforeRecomputeCommit: async () => {
        if (fired) return;
        fired = true;
        await engine.ingest(quote("q-late", "p1", 16, D2, 11, {source_seq: 7}));
      },
    },
  });
  await seedPoint(engine, {point_id: "p1"});
  await engine.ingest(quote("q1", "p1", 10, D2, 9));
  const key = engine.periodKey("prod-1", "R1", D2);
  const blocked = await engine.recomputePeriod(key);
  assert.equal(blocked, "stale_blocked");
  assert.equal(store.snapshot().indexPeriods[key], undefined, "旧结果不得回写");

  // tick 重试：迟到报价（观察时刻更晚）最终被采用
  const report = await engine.tick(T0 + 1);
  assert.ok(report.recomputed >= 1);
  const period = store.snapshot().indexPeriods[key];
  assert.ok(period.values.length >= 1);
  assert.equal(period.values[period.values.length - 1].value, 16);
});

test("进程重启后继续隔离处理、到期替代和重算任务", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "price-ledger-"));
  const file = path.join(dir, "state.json");
  try {
    const s1 = makeEngine({file});
    await seedPoint(s1.engine, {point_id: "p1"});
    await seedPoint(s1.engine, {point_id: "p2"});
    await s1.engine.ingest(quote("q1", "p1", 10, D2, 9));
    await s1.engine.ingest(quote("q2", "p2", 20, D2, 9, {source_seq: 2}));
    // 一条隔离记录（同 event_id 异文，待人工继续处理）
    await s1.engine.ingest(quote("q1", "p1", 999, D2, 9, {source_seq: 3}));
    // 一个已批准、1 秒后到期的替代
    await s1.engine.ingest(unavailable("u1", "p1", D2, 10, 5));
    await s1.engine.tick(T0);
    const from = Date.parse(`${D2}T10:00:00${TZ}`);
    await s1.engine.approveSubstitution(`eval-p1-${D2}`, {basis: "重启前批准", validFromMs: from, validToMs: T0 + 1000});
    // 一个待执行重算任务
    await s1.engine.ingest(quote("q4", "p2", 21, D2, 11, {source_seq: 6}));
    assert.ok(Object.values(s1.store.snapshot().tasks).some((t) => t.status === "pending"));

    // 模拟进程重启：全新 Store/Engine 从同一文件恢复（时刻超过隔离任务退避窗口）
    const restartAt = T0 + 70_000;
    const s2 = makeEngine({file, now: restartAt});
    await s2.store.load();
    const report = await s2.engine.tick(restartAt);
    assert.ok(report.expired >= 1, "到期替代在重启后继续执行");
    assert.ok(report.recomputed >= 1, "待执行重算在重启后继续");
    assert.ok(report.quarantine_pending >= 1, "隔离处理在重启后仍可见待办");
    const state2 = s2.store.snapshot();
    assert.equal(Object.values(state2.substitutions)[0].status, "expired");
    assert.equal(state2.quarantine["q1"].status, "pending");
    assert.ok(state2.indexPeriods[s2.engine.periodKey("prod-1", "R1", D2)]);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test("质量变更按来源序号幂等接收，并改变后续替代评估的质量等级基线", async () => {
  const {engine, store} = makeEngine();
  await seedPoint(engine, {point_id: "p1", quality_grade: "B"});
  await seedPoint(engine, {point_id: "p2", quality_grade: "A"});
  await engine.ingest(quote("q1", "p1", 10, D1, 9));
  await engine.ingest(quote("q2", "p2", 20, D1, 9));

  // p1 在缺货前先发生质量变更 B → A
  const qc = {
    event_id: "qc1", source_seq: 4, source_id: "src-1", point_id: "p1",
    event_type: "quality_change", quality_grade: "A",
    observed_at: `${D1}T20:00:00${TZ}`,
  };
  assert.equal((await engine.ingest(qc)).status, "accepted");
  assert.equal((await engine.ingest(qc)).status, "duplicate");
  await engine.ingest(unavailable("u1", "p1", D1, 23, 5));
  await engine.tick(T0);

  const ev = store.snapshot().evaluations[`eval-p1-${D1}`];
  const p2 = ev.candidates.find((c) => c.point_id === "p2");
  assert.equal(p2.quality_delta, 0, "质量变更后 p1 等级按 A 计，与 p2 无质量差异");
  assert.equal(store.snapshot().points["p1"].quality_grade, "A");
});

test("trace 可按任一观察时刻还原原始事件、替代路径、采用规则与进入指数的数值", async () => {
  const {engine, store} = makeEngine();
  for (const pid of ["p1", "p2"]) await seedPoint(engine, {point_id: pid});
  await engine.ingest(quote("q1", "p1", 10, D1, 9));
  await engine.ingest(quote("q2", "p2", 20, D1, 9));

  // 缺货之前的时刻：只看得到原始报价，采用价来自本点
  const before = Date.parse(`${D1}T22:00:00${TZ}`);
  const t1 = engine.trace({productId: "prod-1", region: "R1", atMs: before});
  const p1t1 = t1.points.find((p) => p.point_id === "p1");
  assert.equal(p1t1.events.length, 1);
  assert.equal(p1t1.events[0].event_id, "q1");
  assert.equal(p1t1.adopted.price, 10);
  assert.equal(p1t1.adopted.substituted_via, undefined);

  await engine.ingest(unavailable("u1", "p1", D1, 23, 5));
  await engine.tick(T0);
  const from = Date.parse(`${D1}T23:00:00${TZ}`);
  await engine.approveSubstitution(`eval-p1-${D1}`, {basis: "trace 审计补采", validFromMs: from, validToMs: from + 86400000});
  const key1 = engine.periodKey("prod-1", "R1", D1);
  await engine.recomputePeriod(key1);
  await engine.publishIndex(key1);

  // 月末复核时刻（初算与发布都已完成）：替代路径、固定要素、审批依据、规则版本全部可还原
  const t2 = engine.trace({productId: "prod-1", region: "R1", atMs: T0});
  const p1t2 = t2.points.find((p) => p.point_id === "p1");
  assert.equal(p1t2.events.length, 2);
  assert.equal(p1t2.adopted.price, 20);
  assert.equal(p1t2.adopted.path.join(">"), "p1>p2");
  assert.equal(p1t2.adopted.substitution.policy_version, "quote-substitution-1");
  assert.equal(p1t2.adopted.substitution.approval.basis, "trace 审计补采");
  assert.deepEqual(p1t2.adopted.substitution.fixed, {spec: {size: "500g"}, region: "R1", store_level: "standard"});
  const idx = t2.indexes.find((i) => i.key === key1);
  assert.equal(idx.status, "published");
  assert.equal(idx.adopted_value, 20);
  assert.equal(idx.rule_version, "quote-substitution-1");
  assert.ok(idx.versions.length >= 1);
  assert.ok(idx.contributions.find((c) => c.point_id === "p1").substituted_via);

  // 更早的时刻（观察日尚未发生）：指数不可见
  const tEarly = engine.trace({productId: "prod-1", region: "R1", atMs: before});
  assert.equal(tEarly.indexes.length, 0);
});
