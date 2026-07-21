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

服务端只提供 authenticated Streamable HTTP `POST /mcp`，Phase 3 仅允许 loopback。它不提供服务端 stdio，也不直读 MySQL、Qdrant 或 storage。API、worker 和依赖必须在 skill/launcher 之外运行。

Codex / MCP client 通过用户机 launcher 连接：

```json
{
  "mcpServers": {
    "enterprise-hub": {
      "command": "npm",
      "args": ["run", "--silent", "mcp:launcher"],
      "cwd": "/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER",
      "env": {
        "ENTERPRISE_HUB_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

launcher 只保存进程内存中的 development JWT；退出后必须重新用员工 email 登录。它不会启动或修复服务。手动启动：

```sh
ENTERPRISE_HUB_BASE_URL=http://127.0.0.1:3000 npm run mcp:launcher
```

MCP 配置、环境和文件中不得保存 bearer token。

MCP 调用方不要提供组织 ID；组织边界始终由服务端从当前登录员工推导。Evidence search 的 cursor 是不透明、短期有效的翻页 token：下一页必须沿用相同 query/filter/limit 原样传回 `page.nextCursor`。遇到 `INVALID_CURSOR` 可不带 cursor 重新开始；遇到 `CURSOR_EXPIRED`，先说明 cursor 已过期，只有用户仍希望继续时才重新搜索。结构化导入只有在同一个文件和同一组 metadata 精确重试时才复用 `idempotencyKey`；精确重放会返回第一次持久化的 ID/storage key，不可见的 import status 与不存在批次一样返回非枚举 404。

## 当前 MCP Tools

| Tool                           | 用途                                        |
| ------------------------------ | ------------------------------------------- |
| `enterprise_hub_login_local`   | 用 seeded email 登录 launcher 内存 session  |
| `enterprise_hub_logout_local`  | 清除 launcher 内存 session                  |
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

可重复的完整步骤见 `docs/implementation/local-agent-test.md`。在本仓库的 Codex task 中可以直接说：

```text
你来替我执行一遍 SME_DATA_CENTER 的手动测试。
```

Codex 会使用 repo-local `enterprise-hub-manual-test` skill 重置专用本地测试数据、启动 API/worker，并创建独立的用户可见 Codex tasks 保存上传、冷启动检索、权限隔离和结构化查询记录。报告和脱敏日志保存在 ignored `.data/manual-tests/<runId>/`。

员工侧 task 只会收到场景清单里的自然语言原文。英文测试边界、MCP 专业术语、标签/幂等细节、查询形态和预期答案都留在控制器侧，不会混进可见用户话术。

手工执行的核心路径：

1. 用 `enterprise_hub_login_local` 登录 `baoli.manager@example.com`。
2. 用 `enterprise_hub_list_labels` 选择 `store:baoli`。
3. 用 `upload_evidence_document` 上传 MD/TXT/DOCX，随后用 `get_evidence_document_status` 等待 index ready，再用 `search_document_evidence` 检索。
4. 用 `upload_structured_dataset` 上传 `dishes` 或 `business` CSV/XLSX，随后用 `get_import_status` 和 `query_structured_dataset` 验证。
5. 用 `suzhou.manager@example.com` 搜同一内容，确认没有跨店数据、文件名、行数或存在性泄漏。

## npm scripts

| Script                 | 功能                                            |
| ---------------------- | ----------------------------------------------- |
| `format`               | 用 Prettier 格式化仓库                          |
| `format:check`         | 检查 Prettier 格式                              |
| `lint`                 | 运行 ESLint                                     |
| `test`                 | 运行 Vitest                                     |
| `test:integration`     | 跑 Phase 3 local API/worker integration         |
| `test:mcp`             | 跑 Phase 3 local MCP smoke                      |
| `test:phase3:golden`   | 跑 synthetic retrieval golden gate              |
| `test:phase3:perf`     | 跑真实本地 compiler/CSV parser/payload 性能门禁 |
| `test:manual:prepare`  | 重建本地手动验收 MySQL/Qdrant/storage 环境      |
| `test:manual:serve`    | 启动并保持手动验收 API + worker                 |
| `test:manual:snapshot` | 保存本地 operator 数据/索引状态快照             |
| `test:manual:cleanup`  | 保存最终快照并停止本地依赖                      |
| `typecheck`            | 运行 TypeScript 类型检查                        |
| `api:dev`              | 启动 Fastify API                                |
| `mcp:launcher`         | 启动本机 launcher，连接已运行的 HTTP MCP        |
| `purge-data`           | 清理本地文档数据和 ignored storage              |
| `worker:dev`           | 启动 worker loop                                |
| `worker:once`          | 跑一次 worker pass                              |
| `runtime:compose:up`   | 启动 MySQL + Qdrant                             |
| `qdrant:init`          | 初始化/更新 Qdrant evidence collection          |
| `readyz:local`         | 运行本地 readiness checks                       |
| `db:generate`          | 生成 Prisma client                              |
| `db:migrate`           | 应用本地 Prisma migrations                      |
| `db:seed`              | 写入本地 seed 数据                              |

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

确认 MCP client 使用 `npm run --silent mcp:launcher`，并重启 Codex 或新开 thread。不要在普通上传/搜索任务里 fallback 到脚本、curl、数据库或 storage。

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
