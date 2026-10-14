# 证据检索资料必须等完整索引就绪后才 active

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

Phase 3 将 MD/TXT/DOCX 从简单关键词搜索升级为 hybrid evidence retrieval。证据检索承诺依赖解析、结构/语义切块、embedding、Qdrant 向量索引、词法索引、rerank metadata 和 MySQL 版本记录。若源资料在索引未完成时进入检索 active，调用方智能体会遇到部分可见、漏召回或排序质量不一致的问题。

**Decision**: MD/TXT/DOCX 源 `Document` 只有在源文件持久化、MySQL metadata、审计、解析、切块、embedding、Qdrant upsert、词法索引和版本化索引记录全部成功后，才能成为证据检索可见的 active 资料。向量索引或词法索引任一路失败时，资料不能进入证据检索。

Phase 3 应使用 `ProcessingRun` 和版本化 `DocumentIndex` 或等价记录追踪 `contentVersion`、`embeddingVersion`、`chunkerVersion`、`lexicalIndexVersion` 和索引状态。重试创建新的 `ProcessingRun`，复用未变更源文件，用幂等 chunk/vector id upsert Qdrant；成功后再发布 active。

**Considered Options**: 源文件保存后立即 active；仅向量索引成功即可 active；索引失败时降级为关键词或源文件搜索；把文件可下载状态和证据检索 active 混在一起。

**Consequences**: 调用方只会检索到完整 hybrid evidence index 覆盖的资料，质量和状态更一致。代价是上传后到可检索之间有处理延迟；失败资料需要清晰状态、错误信息和重试入口。源文件仍可保留用于授权下载/诊断，但不能作为证据检索结果返回。
