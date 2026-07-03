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

## 本地使用前检查

在 `local-development` 使用 MCP tools 前：

1. 确认本地 MySQL 正在运行，且 seed 数据已存在。
2. MCP client 优先启动 `npm run --silent mcp-bootup`，可选传入 `ENTERPRISE_HUB_MCP_SESSION_FILE`。这个 bootup command 会读取 `.env`、启动 API、等待 `/healthz`、启动本地 worker loop，然后启动 MCP stdio。
3. 如果只启动 `npm run mcp:dev`，必须确认 API 已经在 `ENTERPRISE_HUB_API_URL` 指向的地址运行。
4. MCP client 的 npm args 必须使用 `--silent`，避免 npm banner 污染 MCP stdio stream。
5. 选择员工 session 后，先调用 `enterprise_hub_login_dev`，再调用 `enterprise_hub_list_labels`。
6. 如果当前 thread 没有暴露 enterprise-hub MCP tools，要先明确说明 MCP tools 不可用；只有在用户要你继续完成本地操作时，才 fallback 到仓库 CLI/API。CLI/API fallback 仍必须走后端授权，不得直读 DB/storage，并且应启动 API + `npm run worker:dev` 后台 loop 来模拟线上 worker 行为；不要把 `npm run worker:once` 当成默认上传步骤。

设置命令参考：

- `AGENTS.md`：本地常用命令。
- `docs/implementation/local-agent-test.md`：完整人工测试流程。

## 初始化 MCP Client

当用户说“初始化服务”“把 Enterprise Hub MCP 连上”“修一下 Codex MCP 配置”“使用 Enterprise Hub MCP skill 帮我把服务初始化”时：

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

4. **处理状态**
   - 上传后调用 `enterprise_hub_get_document_status`。
   - 如果状态不是 `active`，短暂等待并轮询状态，默认最多约 30 秒；只有 `active` 后才说它已经可搜索。
   - 如果超时仍不是 `active`，报告准确的 `status` 和 `processingRunStatus`，不要声称它已经可搜索。
   - 正常本地 profile 应通过 `mcp-bootup` 的 worker loop 自动处理队列。`npm run worker:once` 只作为旧配置或排障路径，不是普通用户步骤。
   - 如果 fallback 到 CLI/API，也要使用 `worker:dev` 后台 loop 或已经运行的 `mcp-bootup` worker；不要在自然上传流程里直接跑 `worker:once`，除非明确是在排障。

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
- 不要暴露 raw bearer token、session file、production credentials、service account material 或 secrets。
- `local-development` 不要索要 production password。
- 不要声称不可访问文档存在。
- 不要把 企业资料中枢 变成 report generator、dashboard service、skill execution platform 或 employee-facing AI agent。
- 除非用户明确授权具体测试数据，不要上传真实客户导出、第三方下载数据或真实公司资料。

## 失败处理

| 现象                                            | 处理方式                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MCP startup 报 `ENTERPRISE_HUB_API_URL` missing | 优先改用 `npm run --silent mcp-bootup`；如果用 `mcp:dev`，配置 API URL。                                                           |
| MCP client 出现 protocol/JSON startup errors    | 检查 MCP client 是否使用 `npm run --silent mcp-bootup`。                                                                           |
| Tool calls 连接失败                             | 检查 API boot logs、本地 MySQL、API URL/port。                                                                                     |
| 登录返回 `EMPLOYEE_NOT_FOUND`                   | 请用户 seed 本地 DB，或检查 DB/port 是否正确。                                                                                     |
| Tool 返回 `MCP_SESSION_REQUIRED`                | 为目标 `sessionName` 调用 `enterprise_hub_login_dev`。                                                                             |
| 上传成功但搜索为空                              | 先查 status；如果通过 `mcp-bootup` 启动则等待并轮询；旧配置或排障时才运行/请求一次 `npm run worker:once`；只有 `active` 后再搜索。 |
| Suzhou 看不到 Baoli 数据                        | 这是预期权限隔离；除非隐藏标题/数量/存在性泄漏，否则不要当成错误。                                                                 |
