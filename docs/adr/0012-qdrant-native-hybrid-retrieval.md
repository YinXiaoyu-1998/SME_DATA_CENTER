# 使用 Qdrant native hybrid 作为 Phase 3 词法检索默认方案

Phase 3 的 MD/TXT/DOCX 证据检索需要 dense vector + lexical/keyword + rerank。系统已选择 Qdrant 作为默认向量数据库；仍需决定词法索引放在 Qdrant sparse/native hybrid、OpenSearch/Meilisearch、MySQL full-text，还是 in-process BM25。

**Decision**: Phase 3 默认使用 Qdrant sparse vectors / native hybrid retrieval 保存词法索引，与 dense embedding、chunk text 和 payload metadata 使用同一检索存储和 chunk ids。MySQL 仍是权威 metadata/权限/状态数据库，不承担 chunk 级全文检索；in-process BM25 不作为生产基线。

实现时应保留内部 retrieval adapter，例如 `HybridCandidateProvider`，让未来可迁移为 Qdrant dense + OpenSearch/Meilisearch lexical，再由服务层合并候选并 rerank，而不改变外部 evidence API。

**Considered Options**: 使用 OpenSearch 或 Meilisearch 作为独立 lexical engine；使用 MySQL full-text；使用 in-process BM25；只做 dense vector retrieval。

**Consequences**: 单一 Qdrant 检索索引降低 Phase 3 运维复杂度，chunk id、payload filter、版本和重建流程更一致，也避免把事务型 MySQL 变成搜索引擎。代价是 Qdrant lexical tooling 与 dedicated search engine 相比可能更少，中文分词和关键词召回质量必须用生产相似文档评估。如果评估显示 lexical 质量不足，可沿 adapter 迁移到专用搜索引擎。
