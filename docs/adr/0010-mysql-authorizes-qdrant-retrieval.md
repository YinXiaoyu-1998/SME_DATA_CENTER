# MySQL 授权并复核 Qdrant 检索结果

Phase 3 使用 Qdrant 保存 MD/TXT/DOCX 的 chunk text、embedding 和检索 metadata。Qdrant payload 可以包含 `orgId`、`documentId`、标签快照、状态快照和版本信息，但这些信息可能因为资料归档、标签变更、员工禁用、内容替换或异步重建索引而变旧。

**Decision**: MySQL 是文档状态和权限的权威来源。Qdrant payload filters 只用于缩小检索空间，不作为授权真相源。证据检索必须先从 MySQL 解析调用方身份、员工状态、active 文档范围和标签权限，再带着窄化 filter 查询 Qdrant；所有 Qdrant 命中的 chunk 返回前必须再次用 MySQL 校验来源 document 仍 active、调用方仍有权限、版本仍匹配。

资料归档、标签变化、员工禁用或内容替换必须通过 MySQL 立即影响检索可见性。Qdrant 删除、payload 更新或重建索引可以异步执行；任何 stale hit 都必须在返回前被丢弃，并记录 stale-hit 指标用于修复。

**Considered Options**: 完全信任 Qdrant payload 中的标签/状态快照；每次标签变更同步更新所有向量 payload 后才生效；只按 `orgId` 做向量过滤并返回结果；将权限系统复制到 Qdrant。

**Consequences**: 检索安全边界保持在现有 MySQL/Document/Label 权威模型内，归档和权限变更即时生效，不依赖 Qdrant 更新完成。代价是检索路径需要 MySQL scope 查询和返回前复核，可能需要 overfetch、索引优化和 stale-hit 监控来保持召回与延迟。
