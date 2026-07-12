---
name: enterprise-hub-mcp
description: Use when connecting Codex or another MCP client to 企业资料中枢, 初始化 enterprise-hub MCP 配置, testing the local-development profile, authenticating seeded local employees, uploading/searching/archiving documents, checking permission isolation, or preparing staging/production profiles without inventing infrastructure details.
---

# 企业资料中枢 MCP

## 用途

把 企业资料中枢 当作员工自有 agent 可调用的 MCP-backed service。MCP server 只是 HTTP API 的 adapter：不能直读 MySQL 或 storage，不能在客户端做权限过滤，不能执行 Skill Directory 条目，也不能把 企业资料中枢 变成员工直接对话的 AI agent、报表生成器或 dashboard 服务。

## Profiles

| Profile             | 状态   | 连接方式                                               | 鉴权方式                                               |
| ------------------- | ------ | ------------------------------------------------------ | ------------------------------------------------------ |
| `local-development` | 已实现 | 本地 stdio command；优先 `npm run --silent mcp-bootup` | 用 seeded employee email 调 `enterprise_hub_login_dev` |
| `staging-remote`    | 占位   | 未来 remote MCP endpoint 或部署后的 command config     | 未来 staging employee-bound auth/token flow            |
| `production`        | 占位   | 未来 production MCP endpoint                           | 未来 production employee auth/token policy             |

对于 `staging-remote` 和 `production`，不要编造 URL、凭据、token flow、域名、TLS 设置或 service account。缺少批准配置时，停下来问用户。

## 连接边界

本 skill 的主体是“使用企业资料中枢服务”，不是维护本地开发环境。`local-development`、`staging-remote` 和 `production` 的正常操作流程应保持一致；差异只在 MCP client 如何连接服务。

正常上传、搜索、状态查询、下载、归档流程中：

1. 只使用已暴露的 enterprise-hub MCP tools。
2. 不启动 API、worker、MCP server、Docker、MySQL 或任何后台服务。
3. 不 fallback 到仓库 CLI/API、curl、直连数据库或本地 storage。
4. 不修改服务代码、`.env`、MCP config、数据库 schema 或 seed 数据。
5. 如果 MCP tools 不存在、服务未连接、tool call 连接失败或返回服务不可用，明确告诉用户本次操作未完成，并报告“企业资料中枢服务当前不可用/未连接”。可以建议用户先完成连接或联系维护者，但不要自行修复运行环境。
6. 选择员工 session 后，先调用 `enterprise_hub_login_dev`，再调用 `enterprise_hub_list_labels`。

设置命令参考：

- `AGENTS.md`：本地常用命令。
- `docs/implementation/local-agent-test.md`：完整人工测试流程。

## 初始化 MCP Client

只有当用户明确要求“初始化服务”“把 Enterprise Hub MCP 连上”“修一下 Codex MCP 配置”“使用 Enterprise Hub MCP skill 帮我把服务初始化”时，才进入连接配置流程。配置连接不是一次上传/搜索任务的 fallback。

1. 找到 Enterprise Hub repo root。本地默认是 `/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER`；如果不是当前可信 checkout，就询问用户路径。
2. Codex Desktop 使用 `~/.codex/config.toml`。更新或创建 `enterprise-hub` server，让它启动 bootup command：

   ```toml
   [mcp_servers.enterprise-hub]
   command = "bash"
   args = ["-lc", "cd /path/to/SME_DATA_CENTER && npm run --silent mcp-bootup"]
   startup_timeout_sec = 120

   [mcp_servers.enterprise-hub.env]
   ENTERPRISE_HUB_MCP_SESSION_FILE = "/path/to/SME_DATA_CENTER/.data/enterprise-hub-mcp/session.json"
   ```

3. 使用 `mcp-bootup` 时，从 Codex config 删除旧的 `ENTERPRISE_HUB_API_URL` 和 `ENTERPRISE_HUB_MCP_PROFILE`；bootup script 会读取 `.env`、启动 API 和 worker loop，并推导 MCP API URL。
4. 保留其他 MCP servers、plugins、project trust settings 和用户偏好。不要写入 token、password、production endpoint 或真实凭据。
5. 尽量验证 config 语法，然后提醒用户重启 Codex 或新开 thread，让 MCP servers 和 skill 内容重新加载。

通用 MCP client 使用同样形状：

```json
{
  "command": "npm",
  "args": ["run", "--silent", "mcp-bootup"],
  "cwd": "/path/to/SME_DATA_CENTER",
  "env": {
    "ENTERPRISE_HUB_MCP_SESSION_FILE": ".data/enterprise-hub-mcp/session.json"
  }
}
```

## 操作流程

1. **登录/选择 session**
   - 本地只用 seeded email，例如 `baoli.manager@example.com`，调用 `enterprise_hub_login_dev` 并指定 `sessionName`。
   - 不要打印 raw token，不要查看 session file 内容。

2. **读取标签目录**
   - 上传前调用 `enterprise_hub_list_labels`。
   - 只能使用 API 返回的 label keys；不要自造标签。

3. **上传资料**
   - 调 `enterprise_hub_upload_document`，传入本地 `filePath`、`title`、`documentType`、可选 source metadata，以及已存在的 `labelKeys`。
   - 本地人工测试优先使用 synthetic fixture，例如 `fixtures/baoli-june-meituan.csv`。
   - 除非用户明确授权某个测试数据，否则不要要求或上传真实公司资料、真实客户导出、第三方下载数据。

3a. **上传 Phase 3 evidence 文档**

- 对 MD/TXT/DOCX，调 `upload_evidence_document`，传入本地 `filePath`、`title`、可选 `sourceSystem`，以及非空 `labelKeys`。
- 上传工具只读取调用方明确给出的本地文件，然后把 multipart 请求交给 HTTP API；不要直连 storage、Qdrant、MySQL 或模型服务。
- 上传成功只代表服务已接收并开始/完成索引流程；能否检索以 API 返回的状态为准。不要因为上传成功就声称文档已经可搜索。

3b. **上传 Phase 3 structured 数据集**

- 对 XLSX/CSV，仅支持 `dishes` 和 `business`，调 `upload_structured_dataset`。
- 必填 `dataset`、`enterpriseName`、`startDate`、`endDate`、`idempotencyKey`、非空 `labelKeys`；日期是营业日窗口，格式 `YYYYMMDD`。
- API 负责严格结构校验、幂等冲突、active window 冲突和权限校验；MCP 不自行解析表格、不改写业务规则、不绕过导入状态。

3c. **查询 Phase 3 structured 数据**

- 先调 `list_structured_datasets` 获取字段、operators、聚合/排序/分页能力和限制。
- 再调 `query_structured_dataset` 发送受控 JSON query；不要发送 SQL、自然语言查询、公式、趋势分析请求或变更操作。
- 结构化 query 结果是数据行或显式机械聚合结果。不要在本 skill 内生成业务结论、报表或图表。

3d. **检索 Phase 3 evidence chunks**

- 调 `search_document_evidence`，传入调用方 agent 已决定的检索 query，例如“差评处理 SOP”。
- 返回值是 evidence chunks、source metadata、检索/模型版本和 warning；不要把它包装成最终自然语言答案。
- 如果 API 返回空结果或 not-found/inaccessible，按“没有可见证据”处理；不要声称隐藏文档存在。

3e. **读取 structured import 状态**

- 调 `get_import_status` 读取 `importBatchId` 状态。
- not-found/inaccessible 必须按不可见处理，不要泄露隐藏 import batch、源文件名或行数存在性。

4. **处理状态**
   - 上传后调用 `enterprise_hub_get_document_status`。
   - 如果状态不是 `active`，短暂等待并轮询状态，默认最多约 30 秒；只有 `active` 后才说它已经可搜索。
   - 如果超时仍不是 `active`，报告准确的 `status` 和 `processingRunStatus`，不要声称它已经可搜索。
   - 不运行 `worker:once` 或 `worker:dev`；后台处理由企业资料中枢服务自己负责。

5. **搜索/详情/下载**
   - 调 `enterprise_hub_search_documents` 只搜索当前员工可见的 active documents。
   - 只对可见或已知可访问的 document id 调 `enterprise_hub_get_document`。
   - 下载 URL 用 `enterprise_hub_get_document_download_url`。
   - API 返回 not-found/inaccessible 时，按“不可见”处理；不要说隐藏文档存在。

6. **归档**
   - 用户是 uploader/admin 且明确要求时，调用 `enterprise_hub_archive_document`。
   - 归档后验证普通搜索不再返回该文档。

7. **Skill Directory**
   - 只用 `enterprise_hub_list_skills` 读取已批准 metadata 和 instructions。
   - 不要执行 skills，不要生成报表，不要分析文档内容作为这个 skill 的一部分。

## 权限隔离测试

本地验证建议：

1. 用 session `baoli` 登录 Baoli。
2. 上传并激活一个带 `store:baoli` 标签的 fixture。
3. 验证 Baoli 搜索可以找到它。
4. 用 session `suzhou` 登录 Suzhou。
5. 用 Suzhou 搜索同一关键词。
6. 用 Suzhou 尝试读取 Baoli document id 的详情。

预期结果：Suzhou 看不到 Baoli 文档；详情返回 not-found/inaccessible 形状，不能泄露标题、文件名、数量、摘要或存在性。

## 安全规则

- 所有非 health 数据访问必须走 MCP tools 和 HTTP API。
- 不要绕过 API authorization 直读 DB/storage。
- 正常业务流程中不要启动、重启或修复企业资料中枢服务；服务不可用时报告失败。
- 不要暴露 raw bearer token、session file、production credentials、service account material 或 secrets。
- `local-development` 不要索要 production password。
- 不要声称不可访问文档存在。
- 不要把 企业资料中枢 变成 report generator、dashboard service、skill execution platform 或 employee-facing AI agent。
- Phase 3 structured query 只能发送受控 JSON query；不要发送 raw SQL、NL-to-query 指令、公式、window functions、joins 或 mutation 意图。
- Phase 3 evidence search 只能返回证据 chunks/source metadata；最终答案属于调用方员工自用 agent。
- 除非用户明确授权具体测试数据，不要上传真实客户导出、第三方下载数据或真实公司资料。

## 失败处理

| 现象                             | 处理方式                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| MCP tools 未暴露                 | 告诉用户企业资料中枢 MCP 未连接，本次操作未完成；不要 fallback 到 CLI/API 或启动服务。           |
| Tool calls 连接失败              | 告诉用户企业资料中枢服务当前不可用，本次操作未完成；不要自行启动、重启或修复服务。               |
| 登录返回 `EMPLOYEE_NOT_FOUND`    | 报告当前服务没有这个员工身份或本地 seeded identity 不存在；不要自行 seed 数据。                  |
| Tool 返回 `MCP_SESSION_REQUIRED` | 为目标 `sessionName` 调用 `enterprise_hub_login_dev`。                                           |
| 上传成功但搜索为空               | 先查 status；等待并轮询；只有 `active` 后再搜索。超时仍未 active 时报告准确状态，不运行 worker。 |
| Suzhou 看不到 Baoli 数据         | 这是预期权限隔离；除非隐藏标题/数量/存在性泄漏，否则不要当成错误。                               |
