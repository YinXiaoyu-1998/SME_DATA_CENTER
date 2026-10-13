# 企业资料中枢

企业资料中枢是给员工自有 agent、MCP client、API client 和极简管理面使用的数据服务。它不是员工直接对话的 AI agent，不生成自然语言结论，不做报表/dashboard，不执行 Skill Directory 条目。

当前产品面是 Phase 3-only：

- 非结构化证据：上传 MD/TXT/DOCX → 解析/切块/embedding/Qdrant indexing → 检索 evidence chunks。
- 结构化数据：`business`/`dishes` 原始 CSV/XLSX 经流式上传与严格校验后，原子发布为 OSS 门店日分区；其他数据集继续进入 MySQL 受控 JSON 查询。

旧的 legacy ordinary document 入口已经移除。底层 documents catalog/storage/audit 仍作为源文件记录、密级、状态和审计基础设施使用。

## 本地环境

```sh
npm install
cp .env.example .env
```

常用本地变量：

```dotenv
DATABASE_URL="mysql://smedc:smedc_local_password@localhost:3307/smedc"
STORAGE_DRIVER="local"
LOCAL_STORAGE_ROOT="./.data/storage"
CURSOR_SIGNING_SECRET="replace-with-local-development-cursor-secret"
SMEDC_PUBLIC_ORIGIN="https://api.smedatacenter.xyz"
MAX_UPLOAD_BYTES="52428800"

QDRANT_URL="http://127.0.0.1:6333"
QDRANT_COLLECTION_EVIDENCE="smedc_evidence_local"
RETRIEVAL_CONFIG_VERSION="phase3.retrieval.v1"

LLM_PROVIDER="fake"
LLM_MODEL="fake-rerank"
LLM_EMBEDDING_MODEL="fake-embedding"
STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS="120000"
```

不要提交 `.env`、`.data/`、session 文件、真实客户导出、私有 token、服务账号 key 或第三方下载数据。

所有环境统一使用正式的不透明 token 鉴权模型。seed 创建的本地身份没有密码；自动化测试通过
进程内 fixture factory 创建短期正式 session。系统不再提供开发邮箱登录或 JWT 兼容入口。

## 源文件存储

API 和 worker 启动时通过 `STORAGE_DRIVER` 选择同一套存储实现：

- `local`：继续使用原有本地文件适配器，必须配置 `LOCAL_STORAGE_ROOT`。
- `oss`：通过 S3 兼容接口使用阿里云 OSS，必须配置 `AWS_REGION`、`AWS_ENDPOINT`、`AWS_S3_BUCKET`、`AWS_ACCESS_KEY_ID` 和 `AWS_SECRET_ACCESS_KEY`。

OSS 模式下，数据库仍保存与供应商无关的 `org/...` 逻辑 key；实际对象放在 `AWS_S3_PREFIX` 下，默认前缀为 `smedc`。`AWS_SESSION_TOKEN`、`AWS_S3_FORCE_PATH_STYLE` 和 `AWS_S3_PRESIGN_EXPIRES_SECONDS` 是可选项。切换 driver 不会自动迁移原有本地文件；旧文件仍需切回 `local` 读取，或先执行显式迁移。

配置好 ignored `.env` 后，可以运行真实 OSS 生命周期测试：

```sh
set -a; source .env; set +a
npm run test:storage:oss
```

测试只创建一个随机小对象，验证 metadata、读取、预签名下载与删除，且不会打印凭据或签名 URL。

## 本地启动

启动 MySQL 和 Qdrant：

```sh
MYSQL_PORT=3307 npm run runtime:compose:up
```

生成 Prisma client、迁移并 seed：

```sh
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:generate
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:migrate
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:seed
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

## 正式员工 MCP

正式员工路径是通过固定版本的本机 stdio launcher
`smedc-mcp-launcher@0.9.0` 访问远程 `https://api.smedatacenter.xyz`。双归属的
`skills/smedc-mcp/` skill 是当前 OS 用户的安装、配置、浏览器登录、恢复、退出和卸载
权威手册。它禁止 email/password/token/code 对 agent 可见，使用 `smedc_login`、
`smedc_logout`、`smedc_auth_status` 和仅查询当前身份的
`smedc_get_current_user`，且绝不操作服务基础设施。

`smedc-mcp-launcher@0.9.0` 已公开发布并通过独立验证，原生 macOS/Windows launcher
包验证已有记录。当前服务部署与公开推荐证据见 [staging 状态](docs/implementation/staging-readiness.md)；特定客户端完整验收及真实租户激活分别核对。

## MCP 服务与本地开发边界

服务端只提供 authenticated Streamable HTTP `POST /mcp`；staging API 仍只监听 loopback，由
nginx 作为唯一公网入口。它不提供服务端 stdio，也不直读 MySQL、Qdrant 或 storage。API、worker
和依赖必须在 skill/launcher 之外运行。

Codex / MCP client 通过用户机 launcher 连接：

```json
{
  "mcpServers": {
    "smedc": {
      "command": "npm",
      "args": ["run", "--silent", "mcp:launcher"],
      "cwd": "/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER",
      "env": {
        "SMEDC_BASE_URL": "https://api.smedatacenter.xyz"
      }
    }
  }
}
```

Launcher 使用正式浏览器登录；轮换 durable credential 只进入操作系统安全存储，access token
只在内存中。它只接受正式 HTTPS origin，不会启动或修复服务。本地 API/worker 开发由内部
fixture/session 自动化测试覆盖，不会放宽 launcher 的 HTTPS 要求。手动启动：

```sh
SMEDC_BASE_URL=https://api.smedatacenter.xyz npm run mcp:launcher
```

MCP 配置、环境和文件中不得保存 bearer token。

`business` 和 `dishes` 不再写入 MySQL 明细行，也不提供通用行查询。官方 launcher 通过 multipart
流式上传单个原始 CSV/XLSX（默认上限 2 GiB），worker 在全部校验成功后原子发布 OSS 门店日 canonical
CSV，MySQL 仅保存当前分区目录。客户端用 `get_partition_import_status` 等待 `published`，查看 coverage
后通过 `download_structured_partitions` 下载授权分区到本地分析；预签名 URL 不进入模型上下文，调用方须
清理返回的 scratch 目录。

MCP 调用方不要提供组织 ID；组织边界始终由服务端从当前登录员工推导。Evidence search 的 cursor 是不透明、短期有效的翻页 token：下一页必须沿用相同 query/filter/limit 原样传回 `page.nextCursor`。遇到 `INVALID_CURSOR` 可不带 cursor 重新开始；遇到 `CURSOR_EXPIRED`，先说明 cursor 已过期，只有用户仍希望继续时才重新搜索。结构化导入只有在同一个文件和同一组 metadata 精确重试时才复用 `idempotencyKey`；精确重放会返回第一次持久化的 ID/storage key，不可见的 import status 与不存在批次一样返回非枚举 404。

## 菜品目录快照

`dish_catalog` 是一份完整、只追加的菜品目录快照，不是营业日期窗口导入。上传时只提供
`snapshotDate`（`YYYYMMDD`），不得提供 `startDate` 或 `endDate`；服务内部把该日期同时作为
批次起止日期。每个组织只有一条按日期排列的目录时间线：可乱序补录历史快照，但同一日期只能有
一份未归档快照。同日内容纠错应先归档错误快照，再上传新文件；新快照不会自动归档旧快照。

CSV 与 XLSX 都必须使用以下十个受控表头（列顺序可变）：`菜品编码（SPUID）`、
`菜品编码（SKUID）`、`菜品名称`、`品牌`、`基础分类`、`一级分类编码`、`二级分类编码`、
`规格名称`、`售卖价`、`菜品别名`。`二级分类编码`、`规格名称`、`菜品别名` 可空，其余七列必填；
售卖价为 decimal，`0` 合法。同一完整快照中的 SKUID 必须唯一，SPUID 可以因多规格重复。

XLSX 会合并所有表头完全匹配的可见 sheet，sheet 名称不参与识别；不匹配的 sheet（包括总部套餐
sheet）会被忽略并在状态中留下安全摘要。隐藏且匹配的 sheet 会使导入失败。通过 schema discovery
和受控查询中的 `snapshot_date` 查询历史；服务不会选择当前/最新目录、生成 diff，或推断新增、删除、
下架等跨快照状态。

## 常用 MCP Tools

完整工具与管理能力见 [API/MCP 契约](docs/implementation/api-contract.md)。

| Tool                             | 用途                                            |
| -------------------------------- | ----------------------------------------------- |
| `smedc_login`                    | 打开浏览器完成正式登录                          |
| `smedc_logout`                   | 撤销并清除本机共享 session                      |
| `smedc_auth_status`              | 返回不含凭证的认证状态                          |
| `smedc_list_skills`              | 读取已批准 Skill Directory 元数据               |
| `upload_evidence_document`       | 上传 MD/TXT/DOCX evidence 文档                  |
| `get_evidence_document_status`   | 查询 evidence 文档和索引状态                    |
| `search_document_evidence`       | 检索可见 evidence chunks                        |
| `upload_structured_dataset`      | 上传结构化 CSV/XLSX；business/dishes 走分区导入 |
| `get_import_status`              | 查询结构化导入状态                              |
| `list_structured_datasets`       | 查询可用结构化 dataset/字段/operator schema     |
| `get_partition_import_status`    | 查询 business/dishes 分区导入状态               |
| `download_structured_partitions` | 下载授权 business/dishes 分区到本地目录         |
| `query_structured_dataset`       | 查询 row-query 数据集；拒绝 business/dishes     |

## MCP 验证

本地自动化使用 `MYSQL_PORT=3307 npm run test:integration` 和 `MYSQL_PORT=3307 npm run test:mcp`，通过内部正式 session fixture 验证 API/worker/MCP，不添加测试登录端点。

完整官方人工验收只有在明确请求时，按 [正式验收手册](docs/implementation/official-manual-acceptance.md) 及 repo-local `smedc-manual-test` 执行，使用正式 staging、指定 launcher 和人工完成的浏览器凭据输入。不能把本地自动化成功当作正式客户端验收。

聚焦验收应核对当前有效 admin 上传、explicit evidence 类别/完整范围/文件级别、处理终态、当前业务授权的允许与拒绝，以及经营分区的本地下载。真实资料和租户激活各自授权；不要通过默认密级、提升角色或重传掩盖缺项。

## npm scripts

| Script                 | 功能                                            |
| ---------------------- | ----------------------------------------------- |
| `format`               | 用 Prettier 格式化仓库                          |
| `format:check`         | 检查 Prettier 格式                              |
| `lint`                 | 运行 ESLint                                     |
| `test`                 | 运行 Vitest                                     |
| `test:integration`     | 跑 Phase 3 local API/worker integration         |
| `test:storage:oss`     | 跑真实阿里云 OSS 隔离对象生命周期测试           |
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
set -a; source .env; set +a; npm run test:storage:oss
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

`purge-data` 只允许清理 local `localhost` / `127.0.0.1` 且数据库名为 `smedc` 的开发库。它会清理文档源文件记录、处理/索引/审计派生数据和本地测试 storage；不会提交或暴露 secrets。

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

以 [当前文档入口](docs/README.md) 为导航，历史记录不作为现行操作规则。

- `AGENTS.md`
- `docs/implementation/api-contract.md`
- `docs/implementation/env-inventory.md`
- `docs/implementation/local-agent-test.md`
- `docs/implementation/test-cases.md`
- `skills/smedc-mcp/SKILL.md`
