import test from "node:test";
import assert from "node:assert/strict";
import {
  validateQuoteEvent, canonicalPayload, payloadHash, observationDateOf, EVENT_TYPES,
} from "../src/quote-event.js";
import {quote} from "./helpers.js";

test("采价事件要求稳定标识和正序号", () => {
  assert.equal(validateQuoteEvent(quote()).source_seq, 1);
  assert.throws(() => validateQuoteEvent({event_id: "", source_seq: 1}), /event_id/);
  assert.throws(() => validateQuoteEvent({event_id: "evt-1", source_seq: 0}), /source_seq/);
});

test("四类事件均可通过校验，报价必须带正价", () => {
  for (const event_type of EVENT_TYPES) {
    const overrides = {event_type, price: event_type === "quoted" ? 10 : undefined};
    if (event_type === "quality_change") overrides.new_quality_grade = "premium";
    const event = validateQuoteEvent(quote(overrides));
    assert.equal(event.event_type, event_type);
  }
  assert.throws(
    () => validateQuoteEvent(quote({event_type: "quoted", price: -1})),
    /price/,
  );
  assert.throws(() => validateQuoteEvent(quote({event_type: "unknown"})), /event_type/);
});

test("observed_at 被规范为 ISO，时间戳不参与业务指纹", () => {
  const a = validateQuoteEvent(quote({observed_at: "2026-08-15T10:00:00+08:00"}));
  const b = validateQuoteEvent(quote({observed_at: "2026-08-15T11:00:00+09:00"}));
  assert.equal(a.observed_at, b.observed_at);
  assert.equal(payloadHash(a), payloadHash(b));
});

test("业务字段不同则指纹不同；event_id 与 source_seq 不参与指纹", () => {
  const a = validateQuoteEvent(quote({price: 10}));
  const b = validateQuoteEvent(quote({price: 11}));
  assert.notEqual(payloadHash(a), payloadHash(b));
  assert.equal(
    canonicalPayload({...a, event_id: "x", source_seq: 99}),
    canonicalPayload({...a, event_id: "y", source_seq: 1}),
  );
});

test("观察日按规则时区切分", () => {
  const event = validateQuoteEvent(quote({observed_at: "2026-08-31T23:30:00Z"}));
  assert.equal(observationDateOf(event, "Asia/Shanghai"), "2026-09-01");
  assert.equal(observationDateOf(event, "UTC"), "2026-08-31");
});
