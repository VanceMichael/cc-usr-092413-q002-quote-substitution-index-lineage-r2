import test from "node:test";
import assert from "node:assert/strict";
import {validateQuoteEvent} from "../src/quote-event.js";

test("采价事件要求稳定标识和正序号", () => {
  assert.equal(validateQuoteEvent({event_id: "evt-1", source_seq: 1}).source_seq, 1);
  assert.throws(() => validateQuoteEvent({event_id: "", source_seq: 1}), /event_id/);
  assert.throws(() => validateQuoteEvent({event_id: "evt-1", source_seq: 0}), /source_seq/);
});
