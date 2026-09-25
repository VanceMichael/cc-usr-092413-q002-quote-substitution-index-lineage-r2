# 采价缺货替代与指数回溯

保存采价事件、替代决定与指数期间，支持缺货替代、跨日恢复、规则更正与任一观察时刻的历史回溯。

## 开发命令

- 安装依赖：`npm ci`
- 运行测试：`npm test`
- 编译或构建检查：`npm run build`
- 启动服务：`npm start`（数据目录由 `DATA_DIR` 指定，默认 `/data`，端口由 `PORT` 指定，默认 8080）

测试和构建只使用仓库内数据，不需要连接外部业务服务。

## 核心口径

### 事件接收（幂等 + 隔离）

- 四类事件 `quoted` / `unavailable` / `restored` / `quality_change` 均以 `event_id` 为稳定标识、`source_seq` 为来源序号接收。
- 同一 `event_id` 且业务指纹（不含 id、序号、接收时间）一致：幂等重放，仅累加 `duplicate_count`，不产生副作用。
- 同一 `event_id` 但业务指纹不同（同标识异文）：进入隔离队列，不覆盖原文、不触发替代；必须带 `approval_ref` 审批后才能接受（异文取代原文，旧指纹与审批关系留痕）或丢弃。
- 乱序事件按 `observed_at` 解释业务含义，`source_seq` 只维护水位。

### 替代决定

- 采点缺货时，按**失效日当日生效的规则版本**选择候选；规则以版本为单位不可变，更正需登记新版本。
- 决定一旦形成即固定：商品规格（`product_sku`）、地区、门店层级、失败点/替代点质量等级与质量差、有效区间、规则版本、审批依据、触发事件。
- 每个候选（含因在替代链上被排除者）都保存 `considered` 评估记录与未采用原因（地区不符、层级不符、质量超差、窗口失效、排序落败、防环排除等）。
- 替代链沿既有决定逐级追溯，链上点一律排除，**链不得成环**。
- 没有合格候选时保留**缺口**（`status=gap`），绝不沿用过期价格；缺口可在指定观察日显式重估。
- 跨日恢复只把替代窗口收口到恢复日前一天（`valid_to` 固定），历史观察日继续沿旧路径解释；恢复当日没有新报价时同样留缺口。

### 指数回溯

- 观察期（商品 + 地区 + `YYYY-MM`）有开放/发布两态；发布时把每个采点的采用价、替代路径、规则版本与批准号一起冻结为快照。
- 跨日恢复、迟到事件只影响开放期间，不能反向改写已发布观察值。
- 规则更正默认只重算开放期间；对已发布期间，在显式审批（`scope=published`）下按更正规则做假设性重算并追加修订留痕：旧值、新值、差异、差异率、原发布批准与更正批准关系，冻结值不变。
- 重算走 `log_version` 栅栏：任务开始时锁定版本，提交时若已有迟到事件/主数据写入，旧结果被拒绝（`stale_recompute_result`，HTTP 409），需重新取数。

### 重启恢复

- 事件与隔离条目双写审计日志（`events.jsonl` / `quarantine.jsonl`）与原子快照（`state.json`）；快照丢失可从审计日志重建。
- 启动时继续暴露开放隔离条目、按今日重放到期替代（不到点）、把未完成的重算任务按当前版本重新取数后提交。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/events` | 接收采价事件，返回 `accepted` / `duplicate` / `quarantined` |
| GET | `/v1/events` | 已接收事件与序号水位 |
| GET | `/v1/quarantine?status=open` | 隔离队列 |
| POST | `/v1/quarantine/:id/resolve` | 审批处理（`decision` + `approval_ref`） |
| POST | `/v1/points` / `/v1/candidates` | 登记采点 / 替代候选（含有效窗口、优先级） |
| POST | `/v1/policies` | 登记不可变规则版本（`version` + `effective_from`） |
| GET | `/v1/substitutions?point_id=` | 替代决定链（含候选评估原因） |
| POST | `/v1/admin/process-due` | 按指定日期重放到期替代/缺口重估 |
| POST | `/v1/periods` | 打开观察期 |
| POST | `/v1/periods/:sku/:region/:YYYY-MM/publish` | 发布并冻结（`approval_ref`） |
| POST | `/v1/periods/:sku/:region/:YYYY-MM/recompute` | 开放期间重算 |
| POST | `/v1/corrections` | 登记规则更正（默认只影响开放期间） |
| GET | `/v1/index?product_sku=&region=&date=` | 实时指数（几何平均，含缺口与覆盖率） |
| GET | `/v1/trace?point_id=&date=` | **任一观察时刻还原**：原始事件、替代路径、采用规则、最终入指数值 |
| GET | `/v1/recompute-tasks` | 重算任务与栅栏状态 |

指数口径：当日有采用价的采点取几何平均；缺口采点单列在 `gaps`，不以前值填充。
