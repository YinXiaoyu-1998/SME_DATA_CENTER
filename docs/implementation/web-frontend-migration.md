# SMEDC 网页前端迁移实施计划

更新：2026-11-06。状态：**已决策，未实现、未部署**。
权威规格：[Issue #319](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/319)。本文只记录最终决策与分批实施边界；规格冲突处以本文的决策记录为准，并回写 Issue。

## 1. 目标与终态

把现在由 API 进程现场渲染的四个网页界面，搬到一个独立仓库的静态 React 应用，通过 HTTP JSON 契约与后端交互；两端可独立构建、独立发布、互不牵动。

不做（明确排除）：设备授权页 `/oauth/device/verify` 与首次设密码页 `/auth/password/setup` 保留服务端渲染，只换域名；`/v1/*`、`/mcp`、Launcher、工作流安装与调度全部不动。

```
浏览器
  │  https://app.smedatacenter.xyz
  ▼
Nginx（app 站点）
  ├── /                      → 静态 SPA（/opt/smedc/app/current）
  ├── /api/web/v1/*          → proxy 127.0.0.1:3000   （JSON，前端唯一入口）
  ├── /oauth/device/*        → proxy 127.0.0.1:3000   （服务端渲染，保留）
  └── /auth/password/*       → proxy 127.0.0.1:3000   （服务端渲染，保留）

https://api.smedatacenter.xyz（不变）
  ├── /v1/*、/mcp           → MCP / Launcher / 机器客户端
  ├── /.well-known/*        → OAuth issuer（继续等于 api 域）
  └── /oauth/device/verify  → 仅兼容保留，不再生成新链接
```

**硬切**。当前无真实用户（仅开发者本人），因此不设兼容窗口、不做路径别名、不保留旧页面路由；旧渲染层直接删除，不做双跑。

## 2. 锁定的决策

| #   | 决策                                                                                                      | 理由                                                   |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D1  | 前端独立私有仓 `SMEDC_FRONTEND`，零共享代码                                                               | 解耦要求；共享类型包会把耦合请回来                     |
| D2  | 前端只消费 JSON，不消费任何后端渲染的 HTML                                                                | HTML 页面无法独立发布                                  |
| D3  | 后端产出契约（zod → JSON Schema），前端按 commit 生成 zod                                                 | 你已确认；避免手写同步                                 |
| D4  | 浏览器会话继续用 `__Host-` HttpOnly Cookie + CSRF + Origin 校验，不引入 localStorage token                | 管权限的后台，令牌进 JS 可读存储是安全降级             |
| D5  | 前端只认相对路径 `/api/web/v1`，由 Nginx 同源代理；前端代码不出现后端域名                                 | 保留将来换托管位置的自由，零 CORS                      |
| D6  | API 前缀 `/api/web/v1`，资源按 `orgs/:orgId/...` 组织                                                     | 契约不能长成"旧页面的形状"；企业专属入口是既有产品规则 |
| D7  | 环境变量拆为 `SMEDC_API_ORIGIN`（issuer/MCP）与 `SMEDC_WEB_ORIGIN`（网页/Origin/链接）                    | 一个变量承担六种身份是当前硬阻塞                       |
| D8  | 设备授权页、设密码页保留服务端渲染，并在契约中显式标注为"后端渲染页面"                                    | 一次性秘密与 303 交换，做成 SPA 只增加暴露面           |
| D9  | 删除 `apps/admin-web` 与全部网页渲染路由                                                                  | 硬切；无兼容负担                                       |
| D10 | 技术栈最小集：Vite + React + TS + react-router + React Query + 生成式 zod + CSS Modules + headless dialog | 不引入状态库、UI 框架、Tailwind                        |
| D11 | 不引入 PWA / Capacitor / 任何移动端打包                                                                   | 本次只出静态网页                                       |
| D12 | 测试三层：后端路由与契约、前端单测与组件、Playwright 端到端；E2E 放**后端仓**                             | 数据库、种子账号、验收判据都在服务侧                   |
| D13 | 不部署。两个 PR 交付，由你审阅后单独授权线上变更                                                          | 你的明确要求                                           |

## 3. 契约机制

单一事实来源是后端的一份**路由注册表**，不是文档、也不是 OpenAPI：

```
packages/web-api-contract/src/
  registry.ts        // 每条: id / method / path / auth / request? / response / errors[]
  schemas/session.ts permissions.ts workflows.ts ledger.ts
  emit.ts            // z.toJSONSchema 汇总 → contract.json（含 contractVersion、sourceCommit）
```

- 后端所有浏览器路由**只允许**从 registry 注册；有一条测试断言"不存在未登记的 `/api/web/v1` 路由"，以及反方向"登记的每条都能命中"。
- 响应用 `schema.response` 挂到 Fastify：既产出契约，也获得序列化裁剪与提速。副作用是"字段不在 schema 里就会被裁掉"，因此每个端点必须有 golden fixture 测试。
- 工作流那批直接复用 `@smedc/mcp-contract` 的 tool 输入 schema（同一批 handler 两个认证面），新增输出 schema。
- 输出：`npm run contract:emit` → `dist/web-api-contract.json`。
- 前端：`npm run contract:sync --ref <sha>` → 写入 `contract/contract.json` + 生成 `src/api/generated/*.ts`（zod + 类型），记录 `contract.ref`（后端 SHA）。CI 断言"生成结果与 contract.json 一致"（无漂移、可重复）。

## 4. 后端改造清单

新增：

- `packages/web-api-contract`（见上）
- `POST /api/web/v1/session`（登录，返回 identity + csrfToken，签发会话 Cookie）
- `GET /api/web/v1/session`（identity、role、orgId、orgName、可访问企业、csrfToken）
- `DELETE /api/web/v1/session`（注销）
- `/api/web/v1/orgs/:orgId/permissions/{me,categories,stores,dimensions,accounts,documents,enterprises,cutover,cutover/activate}`（沿用现有子资源名与载荷，1:1 迁移）
- `/api/web/v1/orgs/:orgId/workflows/<tool>`（现有 tool 名不变）
- `/api/web/v1/ledger/{context,coverage,pdf,downloads,requests/:requestId,requests/:requestId/download-url}`

改造：

- `SMEDC_PUBLIC_ORIGIN` → `SMEDC_API_ORIGIN` + `SMEDC_WEB_ORIGIN`；Origin 严格相等校验、重定向、CSP `form-action` 改用 web origin；issuer、MCP host 守卫继续用 api origin。
- `SMEDC_WEB_ORIGIN` 允许 loopback `http://`（仅 `localhost`/`127.0.0.1`），其余必须是规范 HTTPS origin——否则本地开发无法登录。
- 4 处网页链接生成改指 web origin：`app-context.ts`、`enterprise-workflows/service.ts`、`auth/routes.ts`（device verification_uri）、`auth/operator-cli.ts`（密码设置链接）。
- SPA 的 CSP 由 Nginx 静态下发：`script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`（台账预览是同源 iframe，已核）。
- 保留 `authPageHeaders`、`renderSafeMessagePage` 及其余两个服务端渲染页面。

删除：

- `apps/admin-web/**`（3,869 行）、`apps/api/src/admin-permissions/routes.ts` 的页面路由、`apps/api/src/ledger-web/routes.ts` 的页面路由与登录路由、权限页与台账页各自的登录/登出表单路由。
- 工作区条目、lockfile、`packages/testing/src/workspace-smoke.test.ts` 相关断言、发布构建里的 admin-web 引用。
- 文档中描述页面渲染实现的段落（`admin-permissions-ui-design.md`、`ledger-pdf-download-center-implementation.md` 等）。

## 5. 前端应用

路由（`app` 域）：

| 路径                                                                | 说明                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/`                                                                 | 按服务端身份跳转：admin → `/admin/:orgId/permissions`；employee → `/ledger` |
| `/login`                                                            | 唯一登录页，支持 `?next=`（只接受站内已知路径）                             |
| `/admin/:orgId/permissions`                                         | 权限设置                                                                    |
| `/admin/:orgId/workflows`、`/admin/:orgId/workflows/:enterpriseKey` | 自动任务                                                                    |
| `/ledger`                                                           | 台账下载中心（员工与管理员共用）                                            |
| `*`                                                                 | 404                                                                         |

目录：

```
src/
  api/        client.ts（CSRF、401/403、错误码→文案）、generated/
  app/        router、layout、nav、role gating、错误页
  i18n/       {zh,en} 字典 + useText()；localStorage 键 smedc-locale
  ui/         ActionButton、Dialog、DataTable、Field、ConflictDiff
  features/
    permissions/  workflows/  ledger/
  styles/      tokens.css + 各组件 *.module.css
```

交互内核（规格里那批按钮规则全部集中在这里，且全部可单测）：

- `useDraft(saved, normalize)`：`pristine | dirty | conflicting`；改回原值、仅顺序变化 → `pristine` → 保存按钮 disabled。
- `ActionButton({ mode, busy, disabledReason, onRun })`：busy 时保留原文案 + 左侧圆形指示器 + disabled + `aria-busy`，鼠标与键盘都无法重复触发；无理由提示。
- `useConfirmFlow()`：准备 → 摘要/影响 → 确认或取消；确认只提交一次；取消保留草稿。
- 版本冲突：保留草稿，展示 before/after 对比，要求显式重新确认；不静默覆盖、不盲重试。
- 会话过期：全局拦截 401 → 阻断提交 + 引导重新登录（草稿不落持久存储，按现有规则）。
- 双语：`{zh, en}` 元组，不用 i18n 框架；业务名称原样显示；`<html lang>` 跟随。

## 6. 测试与门禁

| 层            | 位置                      | 内容                                                                                                                          | 运行                                                     |
| ------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 后端路由/契约 | 后端仓                    | 新前缀下的组织/角色/业务授权矩阵、Origin 矩阵（含 loopback）、会话生命周期、CSRF、冲突、registry 完备性与 golden fixture      | `npm test -- apps/api/src`、`npm run contract:emit` 幂等 |
| 前端单测/组件 | 前端仓                    | `useDraft`/`ActionButton` 全状态、错误码映射、路由守卫、双语覆盖                                                              | `npm test`                                               |
| 端到端        | 后端仓 `scripts/web-e2e/` | Playwright：登录、权限、自动任务、台账 4 条主路径 + 未登录/员工越权/跨组织/会话过期 4 条边界；`SMEDC_WEB_DIR` 指向前端 `dist` | `npm run test:web:e2e`（不进默认 `npm test`）            |
| 回归          | 后端仓                    | `/v1` MCP 全量既有测试**不得修改**，必须全绿                                                                                  | `npm test`                                               |

E2E 种子：`db:seed` 的 `admin@example.com`、`baoli.employee@example.com`、`suzhou.employee@example.com`（跨组织），用一步脚本经 `AuthCore` 直接设定确定性密码，不走邮件/CLI 交互。

## 7. 分批计划

后端仓 A、前端仓 B。每批一个 subagent，文件所有权互不重叠；每批自带聚焦测试与自审。

### 后端（A）

| 批次                    | 目标                                                | 主要拥有                                                          | 依赖         | 可并行         | 验收                                                |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------- | ------------ | -------------- | --------------------------------------------------- |
| **B1 契约内核**         | registry + zod schema + emit + 完备性测试           | 新增 `packages/web-api-contract`、根 `package.json` 脚本          | —            | 阻塞后续全员   | `contract:emit` 两次结果一致；缺登记/多登记都会失败 |
| **B2 来源与会话**       | 双 origin 拆分 + `/session` 三方法 + dev loopback   | `auth/**`、`config/**`、`server.ts`（唯一所有者）、deploy compose | B1           | 与 B5 并行     | Origin 矩阵全绿；local 能登录                       |
| **B3 权限与工作流 API** | 迁移两个子资源族到新前缀，挂响应 schema             | `admin-permissions/**`                                            | B1,B2        | 与 B4、B5 并行 | 路由测试全绿；无页面路由残留                        |
| **B4 台账 API**         | 迁移 `ledger/*`，保留同源流式下载与预览             | `ledger-web/**`                                                   | B1,B2        | 与 B3、B5 并行 | 下载/预览/轮询全绿                                  |
| **B5 环境与文档**       | env 改名、compose、runbook、AGENTS、docs            | `deploy/**`、`docs/**`、`README*`                                 | B2 命名      | 与 B3、B4 并行 | `runtime-image-contract` 等测试绿                   |
| **B6 删除旧渲染层**     | 删 `apps/admin-web`、页面路由、链接改指、工作区清理 | 跨目录删除                                                        | B3,B4        | 串行           | 全仓门禁绿；`grep` 无残留引用                       |
| **B7 端到端与交付**     | Playwright 套件、最终门禁、PR                       | `scripts/web-e2e/**`                                              | B1–B6 + 前端 | 最后           | E2E 全绿；PR 附证据                                 |

### 前端（B）

| 批次                | 目标                                                                           | 依赖    | 可并行                   | 验收                         |
| ------------------- | ------------------------------------------------------------------------------ | ------- | ------------------------ | ---------------------------- |
| **F0 仓库初始化**   | 脚手架、lint/format、vitest+testing-library、CI、README                        | —       | 与 B1 并行               | CI 在空应用上绿              |
| **F1 契约与客户端** | `contract:sync`、生成 zod、API 客户端、错误映射、会话                          | B1      | 与 B2 并行               | 契约生成幂等；客户端单测     |
| **F2 应用骨架**     | 路由、布局、导航、登录页、角色跳转、错误页、i18n、样式基线                     | F1      | 串行                     | 未登录/越权/404 都有正确落点 |
| **F3 交互内核**     | `useDraft`、`ActionButton`、确认流、冲突对比、表格、Dialog                     | F2      | 串行（F4–F6 的共用前置） | 状态机单测覆盖规格全部条目   |
| **F4 权限设置页**   | 类别/门店/维度/账号/文档/准备检查/启用                                         | F3 + B3 | **可与 F5、F6 并行**     | 读写/冲突/空态/双语          |
| **F5 自动任务页**   | 来源、任务设置、持续授权、执行控制、状态与最近运行                             | F3 + B3 | **可与 F4、F6 并行**     | 同上 + 按钮置灰矩阵          |
| **F6 台账下载中心** | 筛选、分页、勾选、预览、打包轮询、历史                                         | F3 + B4 | **可与 F4、F5 并行**     | 下载与轮询全路径             |
| **F7 收口**         | 一致性审查、双语覆盖、a11y、构建与缓存头、发布工作流 + app vhost（只写不执行） | F4–F6   | 串行                     | 全量门禁 + 产物验收          |

并行窗口：

1. **W1**：B1（串行）。
2. **W2**：B2 ‖ B5 ‖ F0 ‖（F1 等 B1 即可开始）。
3. **W3**：B3 ‖ B4 ‖ F2。
4. **W4**：F3（串行前置），同时 B6 准备删除清单。
5. **W5**：**F4 ‖ F5 ‖ F6**（三条独立目录），同时 B6 执行、B7 搭脚手架。
6. **W6**：B7 + F7 收口。

共用文件保护区（避免并行冲突）：`apps/api/src/server.ts`、根 `package.json`、`package-lock.json`、`apps/api/src/config/**` 各由**单一所有者**修改（B2 与 B5），其他批次以补丁说明提交给所有者，不直接编辑。

## 8. 交付

- 两个配对 PR：后端仓（契约 + 接口 + 删除旧层 + E2E）、前端仓（完整应用 + CI + 发布工作流）。PR 说明包含：范围、明确未动项、验证命令与结果、环境变化、人工输入、回退点、增删行数。
- **不部署**：DNS、证书、Nginx reload、镜像发布、入口切换全部不执行，写入 PR 的"待授权"段落。
- 线上变更顺序（仅记录）：备站点 → 加 DNS → 签证书 → 启用 443 → 发布前端 → 切换链接生成位置。

## 9. 需要你输入的人工项

1. 创建私有仓 `SMEDC_FRONTEND`（可由我 `gh repo create`，需你确认仓库名与可见性）。
2. 前端仓的 `main` 保护规则与 Actions 权限。
3. 若要在 CI 里跑 E2E：一条能读后端仓（或前端仓被读）的部署密钥；在此之前 E2E 作为本地必跑门禁并在 PR 贴结果。
4. 发布阶段才需要的 GitHub Environment、SSH 密钥、主机目录与日志。

## 10. 风险

| 风险                               | 影响                 | 对策                                             |
| ---------------------------------- | -------------------- | ------------------------------------------------ |
| Fastify 响应 schema 裁剪字段       | 前端收到缺字段       | 每端点 golden fixture；E2E 兜底                  |
| Origin 拆分漏改                    | app 上所有写操作 403 | 专用 Origin 矩阵测试（api/app/loopback/伪造）    |
| `__Host-` 要求 Secure              | 本地开发无法登录     | `SMEDC_WEB_ORIGIN` 放行 loopback http + 对应测试 |
| 契约漂移                           | 跨仓静默破坏         | emit 幂等 + 前端再生成一致性检查 + 完备性测试    |
| 删除 `admin-web` 波及测试/发布构建 | 门禁红               | B6 单批负责，全仓 `grep` 残留检查                |
| E2E 重型依赖（MySQL/Qdrant）       | CI 慢或不稳          | 仅 `test:web:e2e` 单独作业；默认测试不含         |
| 触碰 `/v1`                         | MCP/Launcher 回归    | 既有 MCP 测试零修改、必须全绿                    |

## 11. 规模预估（占位，PR 时以实际为准）

- 后端：生产/配置 +2,600 / −4,300；测试 +1,900 / −1,100；文档 +700 / −150；运行时与 CI +120。
- 前端（新仓）：生产约 9,000（含约 1,000 行双语文案、约 4,000 行页面、约 2,000 行内核与 API、约 1,500 行样式）；测试约 3,000；CI/部署约 250；文档约 250。
