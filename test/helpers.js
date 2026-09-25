import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export function tempContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cql-test-"));
  return {dir};
}

export function quote(event) {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2, 9)}`,
    source_seq: 1,
    event_type: "quoted",
    point_id: "point-a",
    product_sku: "sku-1",
    region: "R1",
    store_tier: "tier-x",
    quality_grade: "standard",
    observed_at: "2026-08-15T10:00:00+08:00",
    price: 10,
    ...event,
  };
}
