export function validateQuoteEvent(event) {
  if (!event || typeof event.event_id !== "string" || event.event_id.trim() === "") {
    throw new TypeError("event_id 不能为空");
  }
  if (!Number.isSafeInteger(event.source_seq) || event.source_seq < 1) {
    throw new TypeError("source_seq 必须是正整数");
  }
  return Object.freeze({...event});
}
