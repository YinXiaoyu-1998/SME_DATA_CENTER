# 外部 embedding/rerank 模型需要显式数据出境确认

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

Phase 3 倾向使用外部 API 生成 embeddings，并可使用外部 rerank 模型。Embedding indexing 会发送文档 chunk text；检索会发送 query text；rerank 会发送 query text 和候选 chunk text。如果没有明确配置、告知和日志边界，外部模型调用会成为隐式数据出境风险。

**Decision**: 将 embedding/rerank provider 视为显式外部数据处理器。启用前必须由管理员配置 provider/model/base URL/region 等信息，并确认文档 chunks、retrieval queries 和 rerank candidate chunks 可能发送给该 provider。系统默认不发送 raw files、完整文档、用户 secrets、内部 auth headers、员工私有 metadata、无关 org 数据，且不在默认日志、审计、trace、错误或客户端响应中记录原始文本或 provider request/response body。

外部模型 payload 必须最小化：embedding 只发送必要 chunk/query text，rerank 只发送已授权候选 chunk；不得在同一次 provider 请求中混入多个 org 的内容。Fallback provider 必须显式配置，不能静默改发。重试必须有边界和 backoff，且不得扩大 payload。

审计记录只保存外部处理事实和非敏感 metadata，例如 orgId、actor/system actor、documentId/processingRunId/retrievalRequestId、provider/model/version、处理类型、chunk/token count、状态、延迟和时间戳。

**Considered Options**: 默认启用外部模型；将 provider payload 全量写入调试日志；把多个 org 的 chunk 混批提高吞吐；provider 失败时静默切到另一个 provider；完全禁止外部模型。

**Consequences**: 外部模型能力可用，但数据出境是显式、可审计和可关闭的。代价是需要配置/确认流程、日志脱敏、provider 失败处理、成本/延迟监控和安全文档。未配置或未确认时，依赖外部模型的索引/检索能力不能假装可用。
