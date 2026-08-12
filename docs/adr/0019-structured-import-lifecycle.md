# Phase 3 结构化导入采用归档不可查、窗口唯一、无自动替换的生命周期

CSV/XLSX 导入会把源文件中的菜品/营业数据写入 MySQL 查询表。若 baseline 支持自动覆盖、追加、替换或 hard delete，会引入权限、审计、分页一致性、聚合解释、恢复路径和备份保留上的复杂性。Phase 3 的目标是上线前具备可靠数据基座，而不是提供完整数据治理平台。

**Decision**: Phase 3 baseline 将结构化导入建模为可审计的 `ImportBatch`。同一 `{orgId, dataset, startDate, endDate}` 同一时间只能有一个 active/applied 导入窗口；新上传命中已有 active/applied 窗口返回 `ACTIVE_IMPORT_EXISTS`，命中 in-progress 窗口返回 `IMPORT_IN_PROGRESS`。同一 idempotency key + 同一 request fingerprint 返回已有状态；同 key 不同 fingerprint 返回 `IDEMPOTENCY_KEY_CONFLICT`。

源 `Document` 归档后，相关结构化 rows 可以保留在 MySQL 中用于审计、追溯、故障排查和未来恢复，但必须立即不可查询。结构化查询资格同时要求 `ImportBatch.status = applied`、source `Document.status = active`、当前员工有 source Document 标签权限且账号有效。明细、count、sum/avg/min/max、groupBy 和 pagination 都必须在这个权限/状态 scope 后执行。

Phase 3 baseline 不提供普通生产 hard delete/purge，也不提供自动 replace/overwrite/append/reuse。错误 active import 的恢复路径是显式两步：archive old source document/import batch，然后重新上传同窗口新文件。`202` 只表示已排队，不表示完成：客户端轮询可见的 `Document`、`ProcessingRun`、`ImportBatch` 视图，只有 `applied` 可报告成功；`rejected` 或 `failed` 是终态非成功，并给出安全校验/纠正建议。10 分钟仍未终态时报告仍在处理并保留 IDs 供以后查询，不得将其报告为失败或用重传替代轮询。Failed/rejected import 不永久占用 active window；in-progress import 由 worker lease/retry 恢复或失败。

**Considered Options**: 允许同窗口自动覆盖；允许 append/delta import；将 rows 物理删除作为归档语义；提供普通用户 hard delete/purge；让同窗口相同文件自动复用；将 replace 做成 Phase 3 baseline 的一步操作。

**Consequences**: Baseline 语义更保守，权限和审计更清晰，查询不会看到半替换或部分删除状态。代价是用户纠正错误数据需要先归档再重新上传，操作上多一步。Admin-assisted atomic replacement、self-serve overwrite/append、delta import、production purge、retention policy automation 和 rollback UX 进入 P2/P3，并需要单独设计和测试。
