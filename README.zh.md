# 企业资料中枢

企业资料中枢是给员工自有 agent、MCP client、API client 和极简管理面使用的数据服务。它不是员工直接对话的 AI agent，不生成自然语言结论，不做报表/dashboard，不执行 Skill Directory 条目。

当前产品面是 Phase 3-only：

- 非结构化证据：上传 MD/TXT/DOCX → 解析/切块/embedding/Qdrant indexing → 检索 evidence chunks。
- 结构化数据：上传 CSV/XLSX → 严格校验 dishes/business 数据 → MySQL 原子导入 → 受控 JSON 查询。

旧的 legacy ordinary document 入口已经移除。底层 documents catalog/storage/labels/audit 仍作为源文件记录、权限标签、状态和审计基础设施使用。

## 本地环境

```sh
npm install
cp .env.example .env
```

常用本地变量：

```dotenv
DATABASE_URL="mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub"
STORAGE_DRIVER="local"
LOCAL_STORAGE_ROOT="./.data/storage"
JWT_SECRET="replace-with-local-development-secret"
DEV_SEED_ADMIN_EMAIL="admin@example.com"
MAX_UPLOAD_BYTES="52428800"

QDRANT_URL="http://127.0.0.1:6333"
QDRANT_COLLECTION_EVIDENCE="enterprise_hub_evidence_local"
RETRIEVAL_CONFIG_VERSION="phase3.retrieval.v1"

LLM_PROVIDER="fake"
LLM_MODEL="fake-rerank"
LLM_EMBEDDING_MODEL="fake-embedding"
STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS="120000"
```

不要提交 `.env`、`.data/`、session 文件、真实客户导出、私有 token、服务账号 key 或第三方下载数据。

## 本地启动

启动 MySQL 和 Qdrant：

```sh
MYSQL_PORT=3307 npm run runtime:compose:up
```

生成 Prisma client、迁移并 seed：

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed
```

初始化 Qdrant evidence collection：

```sh
npm run qdrant:init
```

启动 API：

```sh
npm run api:dev
```

启动 worker：

```sh
npm run worker:dev
```

只跑一次 worker pass：

```sh
npm run worker:once
```

## MCP 本地服务

MCP server 是 HTTP API adapter；它不直读 MySQL、Qdrant 或 storage。

一条命令启动 API + worker loop + MCP stdio server：

```sh
npm run mcp-bootup
```

Codex / MCP client 推荐配置：

```json
{
  "mcpServers": {
    "enterprise-hub": {
      "command": "npm",
      "args": ["run", "--silent", "mcp-bootup"],
      "cwd": "/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER",
      "env": {
        "ENTERPRISE_HUB_MCP_SESSION_FILE": ".data/enterprise-hub-mcp/session.json"
      }
    }
  }
}
```

如果 API 已经运行，也可以只启动 MCP：

```sh
ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 \
ENTERPRISE_HUB_MCP_SESSION_FILE=.data/enterprise-hub-mcp/session.json \
npm run mcp:dev
```

MCP session 文件可能包含 development bearer token，默认位于 ignored `.data/enterprise-hub-mcp/session.json`。

## 当前 MCP Tools

| Tool                           | 用途                                        |
| ------------------------------ | ------------------------------------------- |
| `enterprise_hub_login_dev`     | 用 seeded email 登录本地 dev session        |
| `enterprise_hub_list_labels`   | 读取可用标签目录                            |
| `enterprise_hub_list_skills`   | 读取已批准 Skill Directory 元数据           |
| `upload_evidence_document`     | 上传 MD/TXT/DOCX evidence 文档              |
| `get_evidence_document_status` | 查询 evidence 文档和索引状态                |
| `search_document_evidence`     | 检索可见 evidence chunks                    |
| `upload_structured_dataset`    | 上传 dishes/business CSV/XLSX 数据集        |
| `get_import_status`            | 查询结构化导入状态                          |
| `list_structured_datasets`     | 查询可用结构化 dataset/字段/operator schema |
| `query_structured_dataset`     | 执行受控只读结构化 JSON 查询                |

## 本地 MCP 人工验证

更完整的步骤见 `docs/implementation/local-agent-test.md`。核心路径：

1. 用 `enterprise_hub_login_dev` 登录 `baoli.manager@example.com`。
2. 用 `enterprise_hub_list_labels` 选择 `store:baoli`。
3. 用 `upload_evidence_document` 上传 MD/TXT/DOCX，随后用 `get_evidence_document_status` 等待 index ready，再用 `search_document_evidence` 检索。
4. 用 `upload_structured_dataset` 上传 `dishes` 或 `business` CSV/XLSX，随后用 `get_import_status` 和 `query_structured_dataset` 验证。
5. 用 `suzhou.manager@example.com` 搜同一内容，确认没有跨店数据、文件名、行数或存在性泄漏。

## npm scripts

| Script               | 功能                                     |
| -------------------- | ---------------------------------------- |
| `format`             | 用 Prettier 格式化仓库                   |
| `format:check`       | 检查 Prettier 格式                       |
| `lint`               | 运行 ESLint                              |
| `test`               | 运行 Vitest                              |
| `test:integration`   | 跑 Phase 3 local API/worker integration  |
| `test:mcp`           | 跑 Phase 3 local MCP smoke               |
| `test:phase3:golden` | 跑 synthetic retrieval golden gate       |
| `test:phase3:perf`   | 跑 deterministic performance smoke gates |
| `typecheck`          | 运行 TypeScript 类型检查                 |
| `api:dev`            | 启动 Fastify API                         |
| `mcp-bootup`         | 启动 API、worker loop 和 MCP server      |
| `mcp:dev`            | 只启动 MCP stdio server                  |
| `purge-data`         | 清理本地文档数据和 ignored storage       |
| `worker:dev`         | 启动 worker loop                         |
| `worker:once`        | 跑一次 worker pass                       |
| `runtime:compose:up` | 启动 MySQL + Qdrant                      |
| `qdrant:init`        | 初始化/更新 Qdrant evidence collection   |
| `readyz:local`       | 运行本地 readiness checks                |
| `db:generate`        | 生成 Prisma client                       |
| `db:migrate`         | 应用本地 Prisma migrations               |
| `db:seed`            | 写入本地 seed 数据                       |

## 验证命令

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
npm run test:phase3:golden
npm run test:phase3:perf
```

## 本地数据清理

```sh
npm run purge-data
npm run purge-data -- --dry-run
npm run purge-data -- --files-only
npm run purge-data -- --all
```

`purge-data` 只允许清理 local `localhost` / `127.0.0.1` 且数据库名为 `enterprise_hub` 的开发库。它会清理文档源文件记录、处理/索引/标签/审计派生数据和本地测试 storage；不会提交或暴露 secrets。

## 常见问题

### MySQL 端口被占用

使用：

```sh
MYSQL_PORT=3307 npm run runtime:compose:up
```

并确保 `DATABASE_URL` 使用 `localhost:3307`。

### MCP tools 未出现

确认 MCP client 使用 `npm run --silent mcp-bootup`，并重启 Codex 或新开 thread。不要在普通上传/搜索任务里 fallback 到脚本、curl、数据库或 storage。

### 上传 evidence 后搜不到

先调用 `get_evidence_document_status`。只有 document active 且 index ready 后才应认为它可检索；否则报告准确状态。

### Structured import 失败

返回服务给出的 validation errors。不要让 MCP client 自行修表、改表头或绕过校验。

### Suzhou 看不到 Baoli 数据

这是预期权限隔离。agent 只能说当前身份没有可见匹配结果，不能泄露隐藏资源存在性。

## 相关文档

- `AGENTS.md`
- `docs/implementation/api-contract.md`
- `docs/implementation/env-inventory.md`
- `docs/implementation/local-agent-test.md`
- `docs/implementation/test-cases.md`
- `skills/enterprise-hub-mcp/SKILL.md`
