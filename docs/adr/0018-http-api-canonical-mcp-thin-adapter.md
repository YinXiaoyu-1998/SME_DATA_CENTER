# Phase 3 HTTP API 是权威契约，MCP 是薄适配层

Phase 3 新增证据检索、结构化 schema discovery、受控结构化查询、结构化上传和导入状态查询。员工智能体会通过 MCP 使用这些能力，但企业资料中枢不能因此出现第二套权限、查询校验、存储访问或业务分析实现。

**Decision**: HTTP API 是 Phase 3 唯一权威后端契约。MCP 仅作为 employee-owned agents 的薄适配层，调用同一套 HTTP API，透传稳定错误码和响应结构。MCP 不直接访问 MySQL、Qdrant、OSS、模型 provider，不复制授权逻辑，不实现独立 structured query compiler，不暴露 worker/admin/operator 控制，不生成最终自然语言答案。

Baseline MCP 可以暴露 evidence search、structured dataset discovery、controlled structured query、structured import upload/status 等员工智能体需要的能力。Evidence search 只返回 evidence chunks 和来源 metadata；structured query 只返回受控结构化数据或调用方显式请求的机械聚合结果。Force reindex、worker retry/cancel、Qdrant repair/snapshot、model/provider config、external egress acknowledgement、field registry editing、ImportWindowClaim repair、hard purge、audit export、readiness/preflight 等保持 HTTP/admin-only 或内部运维入口。

**Considered Options**: 让 MCP 直接连接 MySQL/Qdrant/OSS；在 MCP 层复制 query validation 和 authorization；把 MCP 做成报告/答案生成层；只提供 MCP 不提供 HTTP API；把 admin/operator 能力也暴露给 employee-owned agents。

**Consequences**: 权限、审计、错误模型、query compiler 和测试目标集中在 HTTP 后端，MCP 适配更薄且更安全。代价是 MCP 需要跟随 HTTP contract 更新，并且 MCP 不能绕过 HTTP API 获得更高性能或更多内部控制能力。API contract 和 MCP schemas 必须保持同步测试。
