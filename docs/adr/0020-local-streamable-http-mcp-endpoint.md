# 本地 MCP 采用无状态 Streamable HTTP Endpoint

**Status**: Accepted and implemented for the Phase 3 local boundary

Enterprise Hub 过去只提供本地 stdio MCP adapter。本决策将其迁移为本地 Streamable HTTP endpoint；Phase 3 实现本身不包含 Phase 4 的远端部署、TLS、正式用户登录或服务运维。ADR 0021 的远端 beta token 提案已撤回；正式安装和登录设计见 `docs/implementation/official-user-install-and-login.md`。

**Decision**: 在现有 Fastify API listener 上挂载 `POST /mcp`，使用 MCP Streamable HTTP 的无状态模式。不实现 legacy SSE，不发放 MCP session ID，也不提供匿名 `initialize` 或工具发现。每个请求均以 `Authorization: Bearer <employee token>` 认证，并以请求作用域创建员工上下文和 API delegation client；后端授权和业务审计继续是唯一权威来源。

`/mcp` 硬限制为 `127.0.0.1`/`localhost`。当 API 被显式绑定到 `0.0.0.0` 或其他非回环地址时，`/mcp` 必须禁用或拒绝 endpoint 启动，不提供任何 opt-in escape hatch。此阶段仅支持本地 `http://`，不接受或暗示 `https://`、证书、反向代理和远程部署能力。

移除服务端 stdio adapter 与 `enterprise_hub_login_dev`，使 HTTP `/mcp` 成为唯一服务 MCP transport。用户机 launcher 以 stdio 接收本地 MCP client，提供 `enterprise_hub_login_local`/logout，并将仅存在于 launcher 进程内存的 development JWT 加到每个远端 `/mcp` 请求。HTTP 上传使用 transport-neutral 的显式 Base64 文件对象；任何 transport 都不得把服务端文件路径、数据库、worker 或其他生命周期控制暴露给 agent。

**Considered Options**: 继续只提供 stdio；临时保留 stdio compatibility bridge；在独立端口或独立进程运行 MCP；采用 stateful session ID；实现 legacy SSE；在 HTTP endpoint 中保留 dev-login 工具；在非回环 listener 上自动暴露 `/mcp`；以 skill/MCP 配置保存 bearer token。

**Consequences**: 通用 MCP 客户端通过 launcher 连接服务，同时保持员工身份、权限、审计与错误模型集中在既有后端。旧服务端 stdio 用户必须迁移，不能获得 fallback；launcher 重启后必须重新登录。每个请求独立构建认证执行状态，带来少量对象创建开销，但避免 token、员工身份与文件内容跨请求泄露。完整契约见 `docs/implementation/mcp-endpoint.md`。
