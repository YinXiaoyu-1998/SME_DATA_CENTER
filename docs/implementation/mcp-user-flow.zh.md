# Enterprise Hub MCP 用户流程

最后更新：2026-07-13

本文描述当前 Phase 3 设计里，用户从自然语言请求到 Enterprise Hub MCP
工具执行之间的流转。它是流程和边界说明，不是服务运维手册。主服务运行在本地
还是远端没有本质区别；差别只是 MCP launcher 配置的 Enterprise Hub base URL。

相关文档：

- [本地 MCP endpoint 设计决策](./mcp-endpoint.md)
- [本地 agent 人工测试](./local-agent-test.md)
- [API 和 MCP contract](./api-contract.md)

## 参与者和链路

```mermaid
flowchart LR
  User["用户"]
  Agent["Agent 和 MCP client<br/>Codex、Claude、OpenClaw 等"]
  Skill["enterprise-hub-mcp skill<br/>只提供使用指导"]
  Launcher["MCP launcher<br/>apps/mcp-launcher"]
  ApiMcp["Enterprise Hub API<br/>POST /mcp"]
  Auth["身份签发方<br/>当前：/auth/dev-login<br/>未来：SSO/OIDC"]
  ApiRoutes["已有 authenticated API 行为"]
  Db["MySQL<br/>员工、标签、文档、审计、导入状态"]
  Storage["对象存储<br/>原始上传文件"]
  Worker["Worker<br/>异步处理和索引"]
  Qdrant["Qdrant<br/>evidence 向量"]

  User -->|"自然语言"| Agent
  Agent -->|"读取本地说明"| Skill
  Agent <-->|"MCP stdio"| Launcher
  Launcher <-->|"Streamable HTTP POST /mcp<br/>Authorization: Bearer token"| ApiMcp
  Launcher -->|"登录 bootstrap 请求"| Auth
  ApiMcp -->|"request-scoped delegation"| ApiRoutes
  Auth -->|"员工查验 / token claims"| Db
  ApiRoutes -->|"鉴权、目录、审计、导入状态"| Db
  ApiRoutes -->|"写入/读取原始 bytes"| Storage
  Worker -->|"领取处理任务"| Db
  Worker -->|"读取原始 bytes"| Storage
  Worker -->|"写入/读取 evidence index"| Qdrant
  Worker -->|"发布处理状态"| Db
```

协议摘要：

| 链路                        | 协议 / 通道                      | 是否携带凭证                          | 说明                                                        |
| --------------------------- | -------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| 用户 -> Agent               | 自然语言                         | 不携带 raw token                      | 用户说“上传文件”等任务。                                    |
| Agent -> Skill              | 本地 skill 指令                  | 不携带                                | skill 告诉 agent 如何配置和使用 launcher。                  |
| MCP client -> Launcher      | 本机 MCP stdio                   | 配置中不写 raw token                  | MCP client 根据配置启动 launcher。                          |
| Launcher -> 身份签发方      | HTTP                             | 当前是开发 email；未来可能是 SSO/OIDC | launcher 只把签发的 token 保存在进程内存里。                |
| Launcher -> `POST /mcp`     | Streamable HTTP                  | `Authorization: Bearer <token>`       | launcher 给 initialize、工具发现、工具调用都自动加 header。 |
| API `/mcp` -> 已有 API 行为 | 进程内 request-scoped delegation | 只传 auth context                     | 业务鉴权仍由后端 API 行为负责。                             |
| Worker -> DB/storage/Qdrant | 内部服务调用                     | 服务自身凭证，不是 agent 凭证         | 异步处理不属于 skill/launcher 生命周期。                    |

## 冷启动到上传请求

用户第一句话可能是：

```text
给我上传 xx 文件到 Enterprise Hub。
```

下面的流程同时覆盖两种情况：MCP launcher 还没有配置，以及已经配置但当前还没运行。

```mermaid
flowchart TD
  A["用户冷启动 agent<br/>Enterprise Hub 主服务已在某个 URL 运行"] --> B["用户提出：<br/>上传 xx 文件到 Enterprise Hub"]
  B --> C{"Agent 是否已有<br/>enterprise-hub MCP 配置？"}
  C -->|"没有"| D["Skill 要求补齐配置值：<br/>Enterprise Hub base URL<br/>已注册员工身份"]
  D --> E["Agent 写入该 MCP client 的原生配置<br/>command: npm run --silent mcp:launcher<br/>env: 只包含 ENTERPRISE_HUB_BASE_URL"]
  E --> F["用户按 client 要求重启或刷新 MCP client"]
  C -->|"已有"| G["MCP client 启动或复用 launcher 进程"]
  F --> G
  G --> H{"Launcher 是否已有当前可用的<br/>模型不可见员工 token？"}
  H -->|"有"| I["Launcher 调远端 MCP tools<br/>自动附加 Authorization header"]
  H -->|"没有"| J["业务 tool 返回 EMPLOYEE_AUTH_REQUIRED<br/>或 launcher 报告未本地登录"]
  J --> K["Agent 向用户索取员工身份<br/>当前 dev：注册 email<br/>未来：服务批准的登录/SSO 步骤"]
  K --> L["Agent 调 enterprise_hub_login_local<br/>或未来的本地登录 bootstrap"]
  L --> M{"登录是否成功？"}
  M -->|"否：服务不可达"| N["Agent 报告 URL 无法连接<br/>不启动或修复服务"]
  M -->|"否：身份被拒绝"| O["Agent 要求用户核对身份<br/>不 seed 或修改服务数据"]
  M -->|"是"| P["Launcher 只把 token 存在进程内存<br/>不返回给 agent"]
  P --> I
  I --> Q["Agent 从用户机器读取被选中的本地文件 bytes"]
  Q --> R["Agent 传入 inline Base64 MCP file object<br/>name、mediaType、encoding、contentBase64"]
  R --> S["上传 tool 经 Enterprise Hub 执行"]
  S --> T["Agent 报告服务返回的上传结果<br/>document/import id 和 status"]
```

当前 Phase 3 的细节：launcher 只把 development JWT 保存在进程内存里，所以真正冷启动
launcher 时通常还没有登录。上图“已经登录”的分支，在今天代表一个已经运行且还持有
token 的 launcher 进程；在未来 Phase 4 之后，也可以代表模型不可见的 SSO/OIDC token
来源。

## 已登录上传时序

以下时序从 launcher 已有员工 token 开始。token 可以来自今天的开发 email 登录，也可以来自
未来的 SSO/OIDC；`/mcp` 服务契约仍然是每个请求都用 bearer auth。

```mermaid
sequenceDiagram
  autonumber
  participant U as "用户"
  participant A as "Agent / MCP client"
  participant L as "MCP launcher"
  participant M as "API POST /mcp"
  participant B as "已有上传 API 行为"
  participant D as "MySQL"
  participant S as "对象存储"
  participant W as "Worker"
  participant Q as "Qdrant"

  U->>A: "把这个文件上传到 Enterprise Hub"
  A->>L: "通过 stdio 调 MCP tool：upload_evidence_document 或 upload_structured_dataset"
  L->>M: "Streamable HTTP POST /mcp，带 Authorization: Bearer token"
  M->>M: "校验 loopback、method、JSON、body size、request id、bearer token"
  M->>B: "带 authenticated employee context 做 delegation"
  B->>D: "读取员工、标签、权限、idempotency 状态"
  B->>B: "校验标签权限、inline file shape、metadata、decoded size"
  B->>S: "写入原始上传 bytes"
  B->>D: "创建 document/import、labels、audit event、processing status"
  B-->>M: "业务结果或稳定服务错误"
  M-->>L: "MCP response"
  L-->>A: "MCP response，不含 token"
  A-->>U: "报告 id、accepted status 和下一步 status check"

  W->>D: "稍后领取 processing/import work"
  W->>S: "按需读取原始 bytes"
  W->>Q: "为 evidence document 写入向量"
  W->>D: "发布 active/index-ready 或 validation failure 状态"
```

关键边界：

- Agent 可以读取用户选择的本地文件，并把它编码为 MCP tool input。
- 服务端永远不 dereference 客户端 `filePath`；它只接收 MCP contract 中明确传入的
  inline bytes。
- `/mcp` 对每个请求都鉴权，包括 initialize 和工具发现。
- 标签、上传、查询、搜索可见性、隐藏资源行为都以后端鉴权为准。
- Skill 和 launcher 不启动 API、worker、数据库、storage 或 Qdrant。服务 URL 不可达时，
  agent 只报告连接失败。

## 未登录时序

```mermaid
sequenceDiagram
  autonumber
  participant U as "用户"
  participant A as "Agent / MCP client"
  participant L as "MCP launcher"
  participant Auth as "身份签发方"
  participant D as "MySQL / identity store"
  participant M as "API POST /mcp"

  U->>A: "用 Enterprise Hub 上传/搜索"
  A->>L: "通过 stdio 发 MCP initialize 或业务 tool call"
  L->>M: "POST /mcp，没有可用 bearer token"
  M-->>L: "EMPLOYEE_AUTH_REQUIRED"
  L-->>A: "安全的 login-required 结果"
  A-->>U: "要求提供注册员工身份，或完成服务批准的登录步骤"
  U-->>A: "今天提供 email，未来可能完成 SSO/OIDC"
  A->>L: "今天调用 enterprise_hub_login_local(email)"
  L->>Auth: "HTTP login bootstrap"
  Auth->>D: "验证员工存在且未 disabled"
  Auth-->>L: "员工 token 和安全员工摘要"
  L->>L: "只在进程内存保存 token"
  L-->>A: "返回安全登录状态、email、service URL；永不返回 token"
  A->>L: "重试原本的 MCP 业务 tool"
  L->>M: "POST /mcp，带 Authorization: Bearer token"
  M-->>L: "authenticated MCP response"
```

失败映射：

| 失败                            | 可见结果                                           | Agent 行为                             |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| 缺少 URL                        | 询问 Enterprise Hub base URL                       | 不发明 URL。                           |
| 服务不可达                      | `ENTERPRISE_HUB_UNREACHABLE`                       | 报告连接失败；不启动或修复服务。       |
| token 缺失、过期、launcher 重启 | `EMPLOYEE_AUTH_REQUIRED`                           | 要求用户重新认证。                     |
| 员工不存在或 disabled           | 安全的鉴权失败                                     | 要求用户核对身份；不 seed 或修改员工。 |
| 标签/资源无权限                 | 按后端 contract 返回 forbidden、not found 或空结果 | 不推断隐藏资源存在。                   |

## 上传后的搜索

Evidence search 是独立的 authenticated tool call。上传 accepted 不等于 evidence index 已经 ready。

```mermaid
flowchart TD
  A["上传 accepted"] --> B["Agent 调 get_evidence_document_status"]
  B --> C{"Document active 且<br/>evidence index ready？"}
  C -->|"否"| D["Agent 报告准确服务状态<br/>或按用户要求等待/轮询"]
  C -->|"是"| E["Agent 调 search_document_evidence"]
  E --> F["Launcher 发送 POST /mcp<br/>带 bearer auth"]
  F --> G["API 按员工标签鉴权<br/>只查询可见 evidence"]
  G --> H["MySQL 过滤可见 document ids"]
  H --> I["Qdrant 返回匹配的可见 chunks"]
  I --> J["Agent 返回 evidence chunks/status<br/>不生成业务报告"]
```

Structured query after import 使用同一条 launcher 和 `/mcp` 鉴权链路，但后端执行的是受控
MySQL structured query，而不是 Qdrant evidence retrieval。
