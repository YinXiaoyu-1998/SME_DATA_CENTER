# Phase 3 使用类型化 ProcessingRun 和发布门禁

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

Phase 3 引入重型异步处理：MD/TXT/DOCX 解析、切块、embedding、Qdrant upsert、词法索引；CSV/XLSX 校验和 MySQL 原子导入；ImportBatch 日期窗口声明；外部模型调用；归档/标签变更后的索引修复。仅靠 `Document.status` 无法清楚表达这些任务的类型、幂等、锁、重试、失败和发布门禁。

**Decision**: Phase 3 使用类型化 `ProcessingRun` 和 DB-backed lease 处理后台任务。Baseline job types 包括 `evidence_document_index`、`structured_import_validate`、`structured_import_apply` 和 `index_repair_or_delete`。每个 job 有稳定 dedup/idempotency key、attempt/backoff、`lockedBy`/`lockedUntil`、`availableAt`、`lastHeartbeatAt`、error code、metrics 和明确 publish gate。文档只有完整 evidence index ready 后才 active；结构化导入只有 rows/metadata/claim/audit 全部提交后才 applied/queryable。

Transient failures 可重试，例如外部模型 timeout、临时 DB/Qdrant 故障和 worker crash/lease expiry。Deterministic failures 不重试，例如 malformed file、schema mismatch、invalid date window、unsupported type、active import conflict 和 idempotency conflict。Expired running jobs 可由 worker poller/watchdog 重新入队。

Worker claim 使用数据库 CAS，只允许到期的 `queued`、到期的 `retry_scheduled` 或 lease 过期的 `running` job 被领取。`complete`、`fail` 和 publish gate 必须验证当前 worker 仍持有未过期 lease；heartbeat 只能延长仍由当前 worker 持有的 running job。Transient backoff 为 `min(base * 2^(attempt-1), max)`，当前默认 base `1000ms`、max `60000ms`、最多 `3` 次尝试。

**Considered Options**: 继续只用 `Document.status` 和单一 worker loop；引入外部队列服务作为 Phase 3 baseline；把所有失败都自动重试；把 worker 失败交给人工处理。

**Consequences**: 处理流程可恢复、可审计、可幂等，并且不会在半成品索引或半导入数据时发布 active。代价是 ProcessingRun schema、lease、job dispatcher、retry matrix 和 metrics 更复杂。Operator retry UI、priority queue、dead-letter UI、adaptive concurrency、model reindex dashboard 等作为 P2。
