# Architecture Decision Records（历史决策）

本目录按决策发生时记录背景、选择和后果，保留被取代的方案以解释演进。它不是现行规范的副本；执行任务使用 [当前文档索引](../README.md)。

- 当前身份/登录：[正式登录契约](../implementation/official-user-install-and-login.md)。
- 当前类别/门店/密级授权：[业务权限设计](../implementation/business-related-authorization-design.md)。
- 当前检索和结构化处理：[数据管线](../implementation/data-pipelines.md)、[经营分区](../implementation/structured-partitions.md)。
- 当前公共 HTTP/MCP：[API 契约](../implementation/api-contract.md)。

ADR 0004/0009/0025 等记录的标签或仅密级读取、不可变文件分类、仅运维管理密级等旧规则已被当前业务授权契约取代。ADR 0020/0021 的早期 MCP/令牌方案不是现行登录路径。ADR 0026 的当前分区存储决定仍体现在分区契约中，读取权限采用现行业务授权。

新增 ADR 用于记录真正的新决策；同时更新当前文档，不以在旧文档尾部追加相反结论替代维护。
