# 将结构化导入建模为 ImportBatch

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

> **部分被取代**：ADR 0026 删除 `business` / `dishes` 的 `Document` / `ImportBatch` / row-table 生命周期，改用有限期 partition import job 和 OSS 当前分区。本 ADR 继续约束其他 row-query 数据集。

Phase 3 支持 CSV/XLSX 菜品数据和营业数据导入。一次上传既是源文件资料，也是对结构化查询表的一次原子数据导入。现有 `Document` 记录适合作为源文件、权限、状态和 OSS 锚点，但不足以单独表达导入窗口、行级血缘、校验结果、幂等、并发控制、重复导入策略和结构化审计边界。

**Decision**: 引入 `ImportBatch` 或等价 MySQL 模型，表达一次结构化导入尝试/结果。`Document` 继续表达上传源文件；`ImportBatch` 关联 `Document`、`ProcessingRun`、结构化行表和审计日志。`DishRow` / `BusinessRow` 行必须属于唯一 `ImportBatch`，并保留 `documentId` 以便追溯。

Phase 3 对同一 `{orgId, dataset, start_date, end_date}` 只允许一个 active/applied 导入。新上传命中已有 active/applied 批次时返回冲突错误，不自动覆盖、不追加、不复用、不替换。只有同一 idempotency key 与同一 request fingerprint 的重试可以返回已有批次状态。为避免并发导入和 MySQL partial unique index 限制，使用 `ImportWindowClaim` 或等价事务性声明机制锁定 `{orgId, dataset, startDate, endDate}`。

异步导入采用 reservation-first 顺序：API 只做请求预检，在 MySQL 事务中预留 `Document`、`ImportBatch`、`ImportWindowClaim` 和 started audit，写入并验证 storage 后创建真实 queued `structured_import` `ProcessingRun`，并返回权威 `documentId`、`importBatchId`、确定性 `storageObjectKey` 与 pending/queued 状态（HTTP `202`）。worker 才解析、规范化、校验并以事务应用 rows、source document/batch 状态和 applied/rejected/failed audit。精确重放复用同一组持久化 ID/key，不重复写 object、rows、claim 或 audit；冲突重放在 storage 前失败。客户端必须轮询已有 batch，不得用重传替代等待；同一 idempotency key 仅用于完全相同的 bytes 和 metadata。

**Considered Options**: 只用 `Document` 表达结构化导入；在行表上直接记录文件 id 而没有批次；允许重复上传自动复用或覆盖；用软删除/覆盖替代导入窗口声明。

**Consequences**: `ImportBatch` 让原子导入、失败诊断、幂等、审计、row lineage 和未来手动替换能力边界清晰。代价是多一个持久化模型、更多状态转换和并发控制逻辑。Phase 3 明确不实现自动覆盖、追加、复用或替换，未来如需 replacement workflow 必须单独设计。
