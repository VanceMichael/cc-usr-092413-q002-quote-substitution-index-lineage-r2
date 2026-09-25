import fs from "node:fs";
import path from "node:path";

/**
 * 基于文件的持久化：
 * - state.json 是可变集合的权威快照，tmp+rename 原子落盘；
 * - events.jsonl / quarantine.jsonl 是只追加审计日志，重启后用于核对。
 * 所有写操作同步完成，保证“先落盘再返回”，进程重启后状态不丢。
 */
export class FileStore {
  constructor(dir = process.env.DATA_DIR || "/data") {
    this.dir = dir;
    this.eventsPath = path.join(dir, "events.jsonl");
    this.quarantinePath = path.join(dir, "quarantine.jsonl");
    this.statePath = path.join(dir, "state.json");
    this._listeners = [];
    this.state = this._load();
  }

  initialState() {
    return {
      schema: "consumer-quote-ledger/v1",
      log_version: 0,
      event_watermark: {max_seq: 0, accepted_count: 0, quarantine_count: 0},
      events: {},
      quarantine: [],
      points: {},
      candidates: [],
      policies: [],
      substitutions: [],
      corrections: [],
      periods: {},
      recompute_tasks: [],
      scheduled_tasks: [],
    };
  }

  _load() {
    fs.mkdirSync(this.dir, {recursive: true});
    let state;
    let snapshotExists = true;
    try {
      state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = this.initialState();
      snapshotExists = false;
    }
    // 审计日志存在时做一次条数核对，发现快照落后（或快照丢失）则从日志重建。
    state = this._reconcileWithAudit(state, snapshotExists);
    return state;
  }

  _reconcileWithAudit(state, snapshotExists) {
    const rebuildEvents = () => {
      const rebuilt = new Map();
      if (fs.existsSync(this.eventsPath)) {
        for (const line of fs.readFileSync(this.eventsPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (record.kind === "accepted" || record.kind === "superseded") {
            rebuilt.set(record.event.event_id, record.event);
          }
        }
      }
      return rebuilt;
    };
    const rebuildQuarantine = () => {
      if (!fs.existsSync(this.quarantinePath)) return [];
      return fs.readFileSync(this.quarantinePath, "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line).entry);
    };
    try {
      const fromLog = rebuildEvents();
      if (!snapshotExists || fromLog.size !== Object.keys(state.events || {}).length) {
        state.events = Object.fromEntries(fromLog);
        if (!snapshotExists) {
          state.event_watermark.max_seq = Math.max(
            0, ...[...fromLog.values()].map((e) => e.source_seq),
          );
          state.event_watermark.accepted_count = fromLog.size;
        }
      }
      const quarantineLog = rebuildQuarantine();
      if (!snapshotExists || quarantineLog.length !== (state.quarantine?.length ?? 0)) {
        // 快照里可能已有后续处理结果（accepted/discarded），以快照状态为准补齐条目。
        const byId = new Map((state.quarantine || []).map((q) => [q.quarantine_id, q]));
        state.quarantine = quarantineLog.map((q) => byId.get(q.quarantine_id) ?? q);
        state.event_watermark.quarantine_count = Math.max(
          state.event_watermark.quarantine_count ?? 0, state.quarantine.length,
        );
      }
    } catch {
      // 审计损坏不阻塞启动，state.json 仍可用。
    }
    return state;
  }

  save() {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
    for (const listener of this._listeners) listener(this.state);
  }

  onChange(listener) {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((fn) => fn !== listener);
    };
  }

  appendAudit(file, record) {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  }

  // ---- 事件接收 ----

  getEvent(eventId) {
    return this.state.events[eventId] || null;
  }

  acceptEvent(event, {duplicate = false, approvedFromQuarantine = false, supersede = false} = {}) {
    const existing = this.state.events[event.event_id];
    if (existing && duplicate && !supersede) {
      existing._meta.duplicate_count += 1;
    } else {
      const previous = existing ? {...existing} : null;
      const {payload_hash: _ignored, ...plain} = event;
      this.state.events[event.event_id] = {
        ...plain,
        _meta: {
          received_at: new Date().toISOString(),
          payload_hash: event.payload_hash,
          duplicate_count: existing?._meta.duplicate_count ?? 0,
          approved_from_quarantine: approvedFromQuarantine,
          ...(supersede && previous ? {previous_payload_hash: previous._meta.payload_hash} : {}),
        },
      };
      this.state.event_watermark.max_seq = Math.max(
        this.state.event_watermark.max_seq, event.source_seq,
      );
      this.state.event_watermark.accepted_count += supersede ? 0 : 1;
      this.appendAudit(this.eventsPath, {
        kind: supersede ? "superseded" : "accepted",
        at: new Date().toISOString(),
        event: this.state.events[event.event_id],
        ...(previous ? {previous} : {}),
      });
    }
    this.state.log_version += 1;
    this.save();
    return this.state.events[event.event_id];
  }

  quarantineEvent(entry) {
    const record = {
      quarantine_id: `q-${String(this.state.quarantine.length + 1).padStart(6, "0")}`,
      received_at: new Date().toISOString(),
      status: "open",
      ...entry,
    };
    this.state.quarantine.push(record);
    this.state.event_watermark.quarantine_count += 1;
    this.appendAudit(this.quarantinePath, {kind: "quarantined", at: record.received_at, entry: record});
    this.state.log_version += 1;
    this.save();
    return record;
  }

  resolveQuarantine(quarantineId, decision, approvalRef = null) {
    const entry = this.state.quarantine.find((q) => q.quarantine_id === quarantineId);
    if (!entry) return null;
    entry.status = decision === "accept" ? "accepted" : "discarded";
    entry.resolved_at = new Date().toISOString();
    entry.approval_ref = approvalRef;
    this.state.log_version += 1;
    this.save();
    return entry;
  }

  fenceToken() {
    const w = this.state.event_watermark;
    return `${w.max_seq}:${w.accepted_count}:${w.quarantine_count}`;
  }

  listEvents() {
    return Object.values(this.state.events);
  }
}
