import crypto from "node:crypto";

export const EVENT_TYPES = Object.freeze(["quoted", "unavailable", "restored", "quality_change"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} 不能为空`);
  }
  return value;
}

/**
 * 校验一条采价事件。event_id 是稳定标识，source_seq 是来源系统的单调序号；
 * 原始报价、缺货、恢复、质量变更四类事件走同一套幂等接收规则。
 */
export function validateQuoteEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("事件必须是对象");
  }
  const eventId = requireString(event.event_id, "event_id");
  if (!Number.isSafeInteger(event.source_seq) || event.source_seq < 1) {
    throw new TypeError("source_seq 必须是正整数");
  }
  if (!EVENT_TYPES.includes(event.event_type)) {
    throw new TypeError(`event_type 必须是 ${EVENT_TYPES.join("/")}`);
  }
  const pointId = requireString(event.point_id, "point_id");
  if (Number.isNaN(Date.parse(requireString(event.observed_at, "observed_at")))) {
    throw new TypeError("observed_at 必须是可解析的时间字符串");
  }

  const normalized = {
    event_id: eventId,
    source_seq: event.source_seq,
    event_type: event.event_type,
    point_id: pointId,
    observed_at: new Date(event.observed_at).toISOString(),
    product_sku: requireString(event.product_sku, "product_sku"),
    region: requireString(event.region, "region"),
    store_tier: requireString(event.store_tier, "store_tier"),
    quality_grade: String(event.quality_grade ?? "standard"),
  };

  if (event.event_type === "quoted") {
    const price = event.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new TypeError("quoted 事件的 price 必须是正数");
    }
    normalized.price = price;
    normalized.currency = event.currency ? String(event.currency) : "CNY";
  }
  if (event.event_type === "quality_change") {
    if (event.new_quality_grade === undefined || event.new_quality_grade === null) {
      throw new TypeError("quality_change 事件必须给出 new_quality_grade");
    }
    normalized.new_quality_grade = String(event.new_quality_grade);
    // 质量变更当日仍按原等级采价时可带价；不带价则视为该等级口径暂时缺口。
    if (event.price !== undefined) {
      if (typeof event.price !== "number" || !Number.isFinite(event.price) || event.price <= 0) {
        throw new TypeError("quality_change 事件附带的 price 必须是正数");
      }
      normalized.price = event.price;
    }
    normalized.reason = event.reason ? String(event.reason) : null;
  }
  // 允许来源携带备注，原样保存，便于回溯。
  if (event.note !== undefined) normalized.note = String(event.note);
  return Object.freeze(normalized);
}

/**
 * 业务内容的规范序列化：event_id/source_seq/接收时间不参与指纹，
 * 这样“同一业务事件重放（不同来源序号）”才会被判为同标识异文。
 */
export function canonicalPayload(event) {
  const keys = [
    "event_type", "point_id", "observed_at", "product_sku", "region",
    "store_tier", "quality_grade", "price", "currency", "new_quality_grade", "reason",
  ];
  const picked = {};
  for (const key of keys) if (event[key] !== undefined) picked[key] = event[key];
  return JSON.stringify(picked, Object.keys(picked).sort());
}

export function payloadHash(event) {
  return crypto.createHash("sha256").update(canonicalPayload(event)).digest("hex");
}

export function observationDateOf(event, timezone = "Asia/Shanghai") {
  // 服务统一用 UTC 存储；观察日按规则时区切日。容器内通常带完整 ICU，
  // 取不到 formatter 时退回 UTC 日期。
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(event.observed_at));
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return event.observed_at.slice(0, 10);
  }
}

export function isValidObservationDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
