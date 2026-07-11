# 版本化管理 embedding 与 rerank 模型迁移

Phase 3 使用外部 API 生成 embeddings，并可使用外部 rerank 模型。模型供应商、模型名、base URL 和密钥由环境配置控制。如果直接修改配置并让新 query embedding 查询旧向量，检索质量会不可预测；embedding 维度变化甚至无法在同一向量字段中兼容。

**Decision**: embedding 和 rerank 仍通过 env/secret 配置保持实现简洁，但运行时必须将这些值解析为版本化 retrieval config。每个索引 chunk、DocumentIndex 和检索请求都必须记录 provider、model、dimension、version/config hash、chunker version、lexical version 和 retrieval config version。Embedding 模型变化需要构建并行索引或新 Qdrant collection，经过 golden evaluation 后显式 promote；旧索引保留一段 rollback window。Rerank 模型变化不需要重建向量，但仍需版本化配置、评估、显式 promote 和可独立 rollback。

查询时默认使用当前 active retrieval config。调用方不能任意指定 embedding/rerank 模型；内部评估路径可受控 override。不得用新 query embedding 查询旧 embedding index。外部模型调用必须有 timeout、候选数量上限、批处理、迁移限速、成本/延迟/错误率监控和清晰 fallback 语义。

**Considered Options**: 直接通过 `.env` 修改模型并覆盖旧向量；在同一向量字段混合不同维度/模型；每次模型变更自动全量重建并立即切换；允许调用方选择任意模型。

**Consequences**: 检索质量、成本和回滚路径可控，模型迁移可以被评估和审计。代价是需要 DocumentIndex/retrieval config 版本模型、并行索引存储、迁移任务和 retention 清理逻辑。
