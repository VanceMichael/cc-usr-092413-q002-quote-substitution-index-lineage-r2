import crypto from "node:crypto";

export const EVENT_TYPES = Object.freeze(["quoted", "unavailable", "restored", "quality_change"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 基础校验：仅保证稳定标识与来源序号合法，保持对历史调用方的兼容。
 * 完整的按事件类型校验由 parseQuoteEvent 完成。
 */
export function validateQuoteEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("event 必须是对象");
  }
  if (typeof event.event_id !== "string" || event.event_id.trim() === "") {
    throw new TypeError("event_id 不能为空");
  }
  if (!Number.isSafeInteger(event.source_seq) || event.source_seq < 1) {
    throw new TypeError("source_seq 必须是正整数");
  }
  if (event.event_type !== undefined && !EVENT_TYPES.includes(event.event_type)) {
    throw new TypeError(`event_type 必须是 ${EVENT_TYPES.join("/")} 之一`);
  }
  return Object.freeze({...event});
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} 不能为空`);
  }
  return value;
}

function requireTime(value, field) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new TypeError(`${field} 必须是带时区的 ISO-8601 时间`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${field} 不是合法时间`);
  }
  return ms;
}

function requirePrice(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} 必须是非负有限数值`);
  }
  return value;
}

/**
 * 完整解析一条采价事件，返回归一化记录。
 * 原始报文原样保留在 payload 中，幂等与隔离均基于 canonicalHash 判定。
 */
export function parseQuoteEvent(event) {
  validateQuoteEvent(event);
  const event_id = requireString(event.event_id, "event_id");
  const point_id = requireString(event.point_id, "point_id");
  const event_type = requireString(event.event_type, "event_type");
  if (!EVENT_TYPES.includes(event_type)) {
    throw new TypeError(`event_type 必须是 ${EVENT_TYPES.join("/")} 之一`);
  }
  const observed_at_ms = requireTime(event.observed_at, "observed_at");
  if (event.source_id !== undefined && typeof event.source_id !== "string") {
    throw new TypeError("source_id 必须是字符串");
  }

  const record = {
    event_id,
    point_id,
    event_type,
    source_seq: event.source_seq,
    source_id: event.source_id ?? "default",
    observed_at: event.observed_at,
    observed_at_ms,
  };

  if (event_type === "quoted") {
    record.price = requirePrice(event.price, "price");
    record.currency = event.currency ?? "CNY";
    record.unit = event.unit ?? null;
    if (event.quality_grade !== undefined) record.quality_grade = String(event.quality_grade);
  } else if (event_type === "unavailable") {
    record.reason = event.reason ?? null;
    if (event.expected_resume_at !== undefined) {
      requireTime(event.expected_resume_at, "expected_resume_at");
      record.expected_resume_at = event.expected_resume_at;
    }
  } else if (event_type === "restored") {
    if (event.price !== undefined) record.price = requirePrice(event.price, "price");
    record.currency = event.currency ?? "CNY";
  } else if (event_type === "quality_change") {
    record.quality_grade = requireString(event.quality_grade, "quality_grade");
    if (event.price !== undefined) record.price = requirePrice(event.price, "price");
  }
  return record;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** 同一 event_id 报文的幂等/异文判定均以该哈希为准（服务端接收时间不参与）。 */
export function canonicalHash(event) {
  return crypto.createHash("sha256").update(stableStringify(event)).digest("hex");
}

const OFFSET_CACHE = new Map();

/** 以毫秒为单位的时区偏移（Asia/Shanghai 等），结果取正偏移约定。 */
export function timezoneOffsetMs(timezone, atMs = Date.now()) {
  if (timezone === undefined || timezone === "Asia/Shanghai") return 8 * 60 * 60 * 1000;
  const key = `${timezone}@${Math.floor(atMs / 3_600_000)}`;
  if (OFFSET_CACHE.has(key)) return OFFSET_CACHE.get(key);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = asUTC - atMs;
  OFFSET_CACHE.set(key, offset);
  return offset;
}

/** 返回观察时刻所在观察日（YYYY-MM-DD，按策略时区）。 */
export function observationDay(atMs, timezone = "Asia/Shanghai") {
  const shifted = new Date(atMs + timezoneOffsetMs(timezone, atMs));
  return shifted.toISOString().slice(0, 10);
}

/** 观察日的起止毫秒：[start, end)。 */
export function dayBounds(date, timezone = "Asia/Shanghai") {
  const noonUtc = Date.parse(`${date}T04:00:00.000Z`);
  const offset = timezoneOffsetMs(timezone, noonUtc);
  const start = Date.parse(`${date}T00:00:00.000Z`) - offset;
  return [start, start + 24 * 60 * 60 * 1000];
}
