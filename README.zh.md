# 企业资料中枢

企业资料中枢是一个给员工自有 agent、CLI、MCP 客户端和 API 使用的企业资料服务。它负责保存资料目录、原始文件、本地处理状态、标签权限、审计日志和 Skill Directory 元数据。

它不是员工直接对话的 AI agent，也不是报表生成器、dashboard 服务或 skill 执行平台。所有非健康检查接口都必须通过后端认证和权限过滤。

## 当前本地能力

- 本地 MySQL + Prisma 数据模型、迁移和 seed。
- Fastify API：dev login、资料上传、状态查询、搜索、详情、下载 URL、归档、标签目录、Skill Directory、审计查询。
- 本地文件存储：原始文件写入 ignored `.data/storage`。
- 确定性 worker：支持一次性处理，也支持本地后台 loop 持续处理待处理资料。
- CLI smoke：登录、上传、搜索。
- 本地 MCP server：让 Codex 这类 MCP-capable agent 通过 HTTP API 使用企业资料中枢。
- `enterprise-hub-mcp` skill：指导 agent 安全使用本地 MCP profile。

## 前置依赖

- Node.js 和 npm。
- Docker Desktop 或兼容的 Docker Compose。
- 可用的本地 MySQL 端口。默认是 `3306`；如果被占用，建议使用 `MYSQL_PORT=3307`。

## 安装

```sh
npm install
```

## 本地环境变量

先复制一份本地环境文件：

```sh
cp .env.example .env
```

`.env` 至少包含：

```dotenv
DATABASE_URL="mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub"
STORAGE_DRIVER="local"
LOCAL_STORAGE_ROOT="./.data/storage"
JWT_SECRET="replace-with-local-development-secret"
DEV_SEED_ADMIN_EMAIL="admin@example.com"
```

如果本机 `3306` 已被占用，使用 `3307` 时请把 `.env` 或命令里的连接串改成：

```dotenv
DATABASE_URL="mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub"
```

可选变量：

| Variable                          | 用途                                    | 默认值或示例                            |
| --------------------------------- | --------------------------------------- | --------------------------------------- |
| `MYSQL_PORT`                      | Docker MySQL 暴露端口                   | `3306`，常用本地替代值 `3307`           |
| `PORT`                            | API 监听端口                            | `3000`                                  |
| `HOST`                            | API bind host                           | `0.0.0.0`                               |
| `HUB_API_URL`                     | CLI 调用 API 的地址                     | `http://127.0.0.1:3000`                 |
| `HUB_CLI_SESSION_FILE`            | CLI 本地 session 文件                   | `.data/hub-cli/session.json`            |
| `ENTERPRISE_HUB_API_URL`          | MCP server 调用 API 的地址，必填        | `http://127.0.0.1:3000`                 |
| `ENTERPRISE_HUB_MCP_PROFILE`      | MCP profile                             | `local-development`                     |
| `ENTERPRISE_HUB_MCP_SESSION_FILE` | MCP 本地 session 文件，可能含 dev token | `.data/enterprise-hub-mcp/session.json` |
| `HUB_INTEGRATION_PORT`            | `test:integration` 临时 API 端口        | 自动选择                                |
| `HUB_MCP_TEST_PORT`               | `test:mcp` 临时 API 端口                | 自动选择                                |

不要提交 `.env`、`.data/`、本地 session 文件、真实凭据、真实客户资料或第三方下载数据。

## 本地上传文件存在哪里

本地 profile 使用 local storage driver 时，上传原始文件会存到 `LOCAL_STORAGE_ROOT`。默认本地路径是：

```text
.data/storage/org/<org_id>/documents/<document_id>/original/<filename>
```

集成测试和 MCP smoke 测试会使用各自的 ignored 目录：

```text
.data/integration/storage
.data/mcp-local-test/storage
```

只清理本地上传文件和测试 storage，保留 CLI/MCP 登录 session：

```sh
npm run purge-data
```

先预览会删哪些目录：

```sh
npm run purge-data -- --dry-run
```

如果想把 ignored `.data` 整个删掉，包括本地 CLI/MCP session 文件：

```sh
npm run purge-data -- --all
```

这个命令不重置 MySQL 里的资料目录记录。如果你还想清空本地数据库，请重新跑 migration reset/seed 流程，或使用已有 integration smoke 脚本。

## 启动本地数据库

推荐使用 `3307`，避免和本机已有 MySQL 冲突：

```sh
MYSQL_PORT=3307 docker compose up -d mysql
```

生成 Prisma client，并应用迁移：

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate
```

写入本地 seed 数据：

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed
```

seed 中常用本地员工：

| Email                        | 用途                             |
| ---------------------------- | -------------------------------- |
| `admin@example.com`          | 本地管理员                       |
| `baoli.manager@example.com`  | 保利店 manager，用于上传和搜索   |
| `suzhou.manager@example.com` | 苏州店 manager，用于权限隔离验证 |

## 启动 API

另开一个终端：

```sh
npm run api:dev
```

API 启动入口会自动读取当前目录下的 `.env`（如果存在），且不会覆盖终端里已经显式设置的变量。临时换端口可以这样运行：

```sh
PORT=3033 npm run api:dev
```

健康检查：

```sh
curl http://127.0.0.1:3000/healthz
```

## 运行 worker

普通本地 MCP 使用优先通过 `npm run mcp-bootup` 启动 worker loop。单独调试 worker 时，可以启动本地后台 loop：

```sh
npm run worker:dev
```

也可以执行一次确定性处理，用于测试或排障：

```sh
npm run worker:once
```

worker 会读取 `.env`，并且不会覆盖终端里已经显式设置的环境变量。

## CLI 本地 smoke

API 和 worker loop 启动后，可以用 CLI 走登录、上传、搜索：

```sh
npm run worker:dev
```

保持 worker 终端运行；它会自动处理后续上传队列。

```sh
HUB_API_URL=http://127.0.0.1:3000 \
npm run hub -- login --email baoli.manager@example.com
```

上传 synthetic fixture：

```sh
HUB_API_URL=http://127.0.0.1:3000 \
npm run hub -- documents upload ./fixtures/baoli-june-meituan.csv \
  --title "Baoli June Meituan Export" \
  --type raw_material \
  --label store:baoli
```

等待后台 worker 把资料处理成 `active` 后搜索：

```sh
HUB_API_URL=http://127.0.0.1:3000 \
npm run hub -- documents search "Meituan"
```

`npm run worker:once` 只建议用于 CI、脚本化 smoke 或排障，不是自然本地使用流程。

CLI session 默认写入 `.data/hub-cli/session.json`，不要提交。

## MCP 本地服务

MCP server 是 HTTP API 的 adapter。它不会直接读取 MySQL 或本地 storage。

如果想让本地 agent 一条命令拉起 API + worker + MCP，可以运行：

```sh
npm run mcp-bootup
```

`mcp-bootup` 会读取 `.env`，后台启动 API，等待 `/healthz` 成功，启动本地 worker loop，然后以前台 stdio 方式启动 MCP server。架构上仍然是 MCP 调 API、worker 处理队列，这个脚本只是把本地启动流程串起来，让本地行为接近线上后台 worker 形态。

如果 API 已经在 `http://127.0.0.1:3000` 运行，也可以只启动 MCP：

```sh
ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 \
ENTERPRISE_HUB_MCP_PROFILE=local-development \
ENTERPRISE_HUB_MCP_SESSION_FILE=.data/enterprise-hub-mcp/session.json \
npm run mcp:dev
```

MCP 本地 session 文件可能包含 development bearer token，默认位于 ignored `.data/enterprise-hub-mcp/session.json`。

### Codex 如何连接

在 Codex 或其他支持本地 MCP 的 agent 中，添加一个本地 stdio MCP server。配置的核心是：

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

不同 Codex 版本的 MCP 配置入口可能不同，但需要传给 MCP server 的信息就是上面的 `command`、`args`、`cwd` 和 `env`。这里使用 `--silent` 是为了避免 npm 自己的启动 banner 写入 MCP stdio 通道。

如果当前 Codex 环境能发现 repo-local skill，可以在新 thread 里使用：

```text
Use $enterprise-hub-mcp with the local-development profile to run the local 企业资料中枢 MCP human-test flow. Do not print raw tokens, do not ask for production credentials, and do not claim inaccessible documents exist.
```

常用 MCP tool：

| Tool                                       | 用途                                 |
| ------------------------------------------ | ------------------------------------ |
| `enterprise_hub_login_dev`                 | 用 seeded email 登录本地 dev session |
| `enterprise_hub_list_labels`               | 读取可用标签目录                     |
| `enterprise_hub_upload_document`           | 上传本地文件到资料中枢               |
| `enterprise_hub_get_document_status`       | 查询上传/处理状态                    |
| `enterprise_hub_search_documents`          | 搜索当前员工可见的 active 资料       |
| `enterprise_hub_get_document`              | 读取可见资料元数据                   |
| `enterprise_hub_get_document_download_url` | 获取可见资料下载 URL                 |
| `enterprise_hub_archive_document`          | 归档资料                             |
| `enterprise_hub_list_skills`               | 读取已批准 Skill Directory 元数据    |

权限隔离验证建议：

1. 用 `baoli.manager@example.com` 登录 session `baoli`。
2. 上传 `fixtures/baoli-june-meituan.csv`，标签用 `store:baoli`。
3. 使用 `mcp-bootup` 的后台 worker loop 等待资料变成 `active`；如果只在排障，可以运行一次 `npm run worker:once`。
4. 用 Baoli session 搜索，应能看到资料。
5. 用 `suzhou.manager@example.com` 登录 session `suzhou`。
6. 用 Suzhou session 搜索同一关键词，应看不到 Baoli 资料；详情访问应返回 not found / inaccessible 形状，不能泄露隐藏标题。

更完整的人工 MCP 测试脚本见 `docs/implementation/local-agent-test.md`。

## 一键验证命令

仓库级检查：

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
```

本地 MVP 集成测试：

```sh
MYSQL_PORT=3307 npm run test:integration
```

本地 MCP smoke：

```sh
MYSQL_PORT=3307 npm run test:mcp
```

这两个本地集成脚本会重置本地 development database。不要在有手工调试数据需要保留时运行。

## npm scripts 速查

| Script             | 功能                                       | 运行方法                                                                                                                | 备注                                                             |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `format`           | 用 Prettier 格式化整个仓库。               | `npm run format`                                                                                                        | 会直接改写文件。                                                 |
| `format:check`     | 检查 Prettier 格式，不改写文件。           | `npm run format:check`                                                                                                  | 提交和 PR 前常用。                                               |
| `lint`             | 运行 ESLint。                              | `npm run lint`                                                                                                          | 做静态代码质量检查。                                             |
| `test`             | 运行 Vitest 测试。                         | `npm test`                                                                                                              | 等价于 `npm run test`。                                          |
| `test:integration` | 跑本地 MVP 集成流程。                      | `MYSQL_PORT=3307 npm run test:integration`                                                                              | 会重置本地 development database。                                |
| `test:mcp`         | 跑本地 MCP smoke 测试。                    | `MYSQL_PORT=3307 npm run test:mcp`                                                                                      | 会启动测试所需本地服务，并重置本地测试数据。                     |
| `test:watch`       | 以 watch 模式运行 Vitest。                 | `npm run test:watch`                                                                                                    | 写测试或调试测试时使用。                                         |
| `typecheck`        | 运行 TypeScript 类型检查，不输出编译文件。 | `npm run typecheck`                                                                                                     | 检查全仓 TS 类型。                                               |
| `api:dev`          | 启动 Fastify API 服务。                    | `npm run api:dev`                                                                                                       | 当前会自动读取项目根目录 `.env`，且不覆盖 shell 已传入变量。     |
| `hub`              | 运行 Enterprise Hub CLI。                  | `npm run hub -- <command>`                                                                                              | 示例：`npm run hub -- login --email baoli.manager@example.com`。 |
| `mcp-bootup`       | 启动 API、worker loop，然后启动 MCP。      | `npm run mcp-bootup`                                                                                                    | 配到 MCP client 时建议用 `npm run --silent mcp-bootup`。         |
| `mcp:dev`          | 启动本地 stdio MCP server。                | `ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev`                                                          | 需要 API 已经在对应地址运行。                                    |
| `purge-data`       | 删除 ignored 本地上传和测试 storage 文件。 | `npm run purge-data`；预览用 `npm run purge-data -- --dry-run`；删除整个 `.data` 用 `npm run purge-data -- --all`       | 不会重置 MySQL 里的资料目录记录。                                |
| `worker:dev`       | 启动本地 worker loop，持续处理队列。       | `npm run worker:dev`                                                                                                    | 当前会自动读取项目根目录 `.env`，且不覆盖 shell 已传入变量。     |
| `worker:once`      | 运行一次确定性 worker 处理。               | `npm run worker:once`                                                                                                   | 当前会自动读取项目根目录 `.env`，且不覆盖 shell 已传入变量。     |
| `db:compose:up`    | 启动本地 MySQL Docker Compose 服务。       | `MYSQL_PORT=3307 npm run db:compose:up`                                                                                 | 底层是 `docker compose up -d mysql`。                            |
| `db:compose:down`  | 停止本地 Docker Compose 服务。             | `npm run db:compose:down`                                                                                               | 底层是 `docker compose down`。                                   |
| `db:generate`      | 生成 Prisma client。                       | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate` | schema 或依赖变化后按需运行。                                    |
| `db:migrate`       | 在本地开发数据库上应用 Prisma migration。  | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate`  | 会更新本地 development database。                                |
| `db:seed`          | 写入本地开发 seed 数据。                   | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed`     | 创建 demo 员工、标签和 skills。                                  |

## 常见问题

### MySQL 端口被占用

使用：

```sh
MYSQL_PORT=3307 docker compose up -d mysql
```

并确保 `DATABASE_URL` 使用 `localhost:3307`。

### MCP 提示缺少 `ENTERPRISE_HUB_API_URL`

MCP server 必须显式知道 API 地址：

```sh
ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev
```

### 登录返回 `EMPLOYEE_NOT_FOUND`

通常是数据库没 seed，或者 API 连到了错误端口/数据库。检查：

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed
```

并确认 API 启动时使用同一个 `DATABASE_URL`。

### 上传后搜索不到

普通搜索只返回 `active` 资料。使用 `npm run mcp-bootup` 时，后台 worker loop 会自动处理上传队列；如果你只启动了 API 或正在排障，可以手动运行一次：

```sh
npm run worker:once
```

再搜索。

### Suzhou 看不到 Baoli 资料

这是预期的权限隔离结果。agent 不应该说隐藏资料“存在但不可见”，只能报告 Suzhou 没有可见匹配结果。

## 关闭本地服务

```sh
docker compose down
```

如果要删除本地 MySQL volume，请谨慎使用 Docker volume 清理命令；这会删除本地调试数据。

## 更多文档

- `AGENTS.md`：agent 工作约束和常用命令。
- `docs/implementation/env-inventory.md`：环境变量清单。
- `docs/implementation/api-contract.md`：API 与 MCP tool contract。
- `docs/implementation/local-agent-test.md`：Codex/MCP 人工测试流程。
- `skills/enterprise-hub-mcp/SKILL.md`：repo-local MCP 使用 skill。
