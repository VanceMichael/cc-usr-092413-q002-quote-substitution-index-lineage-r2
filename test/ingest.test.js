import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {FileStore} from "../src/file-store.js";
import {LedgerService} from "../src/ledger.js";
import {quote, tempContext} from "./helpers.js";

function makeLedger(dir) {
  const store = new FileStore(dir);
  const ledger = new LedgerService(store);
  return {store, ledger};
}

test("同一事件重复接收幂等，不新增副作用", () => {
  const {store, ledger} = makeLedger(tempContext().dir);
  const event = quote({event_id: "evt-1", source_seq: 1, observed_at: "2026-08-10T10:00:00+08:00"});
  assert.equal(ledger.ingest(event).status, "accepted");
  assert.equal(ledger.ingest(event).status, "duplicate");
  assert.equal(ledger.ingest(event).status, "duplicate");
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.state.event_watermark.accepted_count, 1);
  assert.equal(store.getEvent("evt-1")._meta.duplicate_count, 2);
});

test("同标识异文进入隔离，既不覆盖也不触发副作用", () => {
  const {store, ledger} = makeLedger(tempContext().dir);
  ledger.ingest(quote({event_id: "evt-1", source_seq: 1, price: 10}));
  const result = ledger.ingest(quote({event_id: "evt-1", source_seq: 2, price: 11}));
  assert.equal(result.status, "quarantined");
  assert.match(result.quarantine_id, /^q-/);
  // 原值保留。
  assert.equal(store.getEvent("evt-1").price, 10);
  const open = ledger.listQuarantine("open");
  assert.equal(open.length, 1);
  assert.equal(open[0].reason, "same_identifier_different_payload");
  assert.equal(open[0].existing_payload_hash, store.getEvent("evt-1")._meta.payload_hash);
});

test("隔离条目必须带审批依据，接受后异文取代原文并保留审批关系", () => {
  const {store, ledger} = makeLedger(tempContext().dir);
  ledger.ingest(quote({event_id: "evt-1", source_seq: 1, price: 10}));
  const q = ledger.ingest(quote({event_id: "evt-1", source_seq: 2, price: 11}));
  assert.throws(() => ledger.resolveQuarantine(q.quarantine_id, "accept", ""), /approval/);
  ledger.resolveQuarantine(q.quarantine_id, "accept", "ticket:Q-77");
  assert.equal(store.getEvent("evt-1").price, 11);
  assert.equal(store.getEvent("evt-1")._meta.approval_ref, "ticket:Q-77");
  assert.equal(store.getEvent("evt-1")._meta.previous_payload_hash !== undefined, true);
  assert.equal(ledger.listQuarantine().length, 1);
  assert.equal(ledger.listQuarantine("accepted").length, 1);
});

test("丢弃隔离异文后原文继续生效", () => {
  const {store, ledger} = makeLedger(tempContext().dir);
  ledger.ingest(quote({event_id: "evt-1", source_seq: 1, price: 10}));
  const q = ledger.ingest(quote({event_id: "evt-1", source_seq: 2, price: 999}));
  ledger.resolveQuarantine(q.quarantine_id, "discard", "ticket:Q-78");
  assert.equal(store.getEvent("evt-1").price, 10);
  assert.equal(ledger.listQuarantine("discarded").length, 1);
});

test("乱序到达不影响接收：序号只做水位，业务以观察时刻排序", () => {
  const {store, ledger} = makeLedger(tempContext().dir);
  ledger.ingest(quote({event_id: "e2", source_seq: 20, observed_at: "2026-08-20T10:00:00+08:00", price: 20}));
  ledger.ingest(quote({event_id: "e1", source_seq: 10, observed_at: "2026-08-10T10:00:00+08:00", price: 10}));
  assert.equal(store.state.event_watermark.max_seq, 20);
  const adoption = ledger.resolveAdoption("point-a", "2026-08-15");
  assert.equal(adoption.price, 10);
});

test("重启后从磁盘重建事件集合与隔离队列", () => {
  const dir = tempContext().dir;
  const {ledger} = makeLedger(dir);
  ledger.ingest(quote({event_id: "evt-1", source_seq: 1, price: 10}));
  ledger.ingest(quote({event_id: "evt-1", source_seq: 2, price: 11}));
  // 模拟快照被删只剩审计日志。
  fs.unlinkSync(`${dir}/state.json`);
  const restarted = makeLedger(dir);
  assert.equal(restarted.store.listEvents().length, 1);
  assert.equal(restarted.store.getEvent("evt-1").price, 10);
  const resume = restarted.ledger.resumeOnStartup("2026-09-01");
  assert.equal(resume.open_quarantine, 1);
});
