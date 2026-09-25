import fs from "node:fs/promises";
import path from "node:path";

const STATE_SCHEMA = 1;

function emptyState() {
  return {
    schema: STATE_SCHEMA,
    counter: 1,
    revision: 0, // 单调修订号：任何状态变更都会推进，用作乐观并发游标
    points: {}, // point_id -> 采价点档案（规格/地区/门店层级/质量等级）
    events: {}, // event_id -> 接收记录
    sourceSeqIndex: {}, // `${source_id}:${source_seq}` -> event_id，来源序号幂等
    quarantine: {}, // event_id -> 隔离记录
    policies: {}, // version -> 策略版本
    policyOrder: [], // 已登记的策略版本，按登记顺序
    evaluations: {}, // eval_id -> 候选评估
    substitutions: {}, // sub_id -> 已批准替代决定
    indexPeriods: {}, // `${product_id}|${region}|${date}` -> 期间（观察值与发布版本）
    corrections: {}, // correction_id -> 规则更正/批准关系
    tasks: {}, // task_id -> 重启后仍需继续的任务
  };
}

/**
 * JSON 文件台账：单次写入走临时文件 + rename 原子替换。
 * path 为 null 时退化为纯内存台账（测试使用）。
 */
export class Store {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.state = emptyState();
    this.#writeChain = Promise.resolve();
    this.loaded = false;
  }

  #writeChain;

  async load() {
    if (this.loaded) return;
    if (this.filePath) {
      try {
        const raw = await fs.readFile(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schema !== STATE_SCHEMA) {
          throw new Error(`不支持的状态版本: ${parsed.schema}`);
        }
        this.state = {...emptyState(), ...parsed};
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    this.loaded = true;
  }

  async #persist() {
    if (!this.filePath) return;
    const tmp = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), {recursive: true});
    await fs.writeFile(tmp, JSON.stringify(this.state), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  /**
   * 在状态草稿上执行变更并串行落盘；并发调用按提交顺序排队，
   * 保证重算与迟到事件不会交错写出。
   */
  async update(mutator) {
    const run = this.#writeChain.then(async () => {
      const draft = structuredClone(this.state);
      const result = (await mutator(draft)) ?? null;
      draft.revision = (draft.revision ?? 0) + 1;
      this.state = draft;
      await this.#persist();
      return result;
    });
    // 排队但不让单次失败卡住后续写入。
    this.#writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 只读快照。 */
  snapshot() {
    return structuredClone(this.state);
  }

  nextId(draft, prefix) {
    const id = `${prefix}-${draft.counter}`;
    draft.counter += 1;
    return id;
  }
}
