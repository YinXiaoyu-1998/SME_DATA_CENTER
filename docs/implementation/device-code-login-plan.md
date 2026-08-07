# Device-Code 登录流程实现计划

Status: accepted by the product owner on 2026-08-07; implementation branch `codex/device-code-login`.

## 摘要

把设计文档中的统一 RFC 8628 device-code 登录实现为唯一官方登录流程：launcher 先取第一方验证
链接，A 形态自动弹浏览器、B/C 形态把链接交给 agent 走员工通道，员工在任意设备输入密码并核对
agent 实例名后完成授权，launcher 轮询 token 端点。无安全存储的主机（支持类 C）用内存态会话，
macOS/Windows 保持 Keychain/Credential Manager 持久会话不变。实现以单个 PR 交付，launcher
发布与 standalone 技能仓库同步作为 PR 合并后的独立步骤。

## 服务端改动

- 新增 Prisma 模型与迁移 `DeviceAuthorization`：只存 `device_code`/`user_code` 哈希、10 分钟
  过期、单次使用、状态机（pending/completed/expired/revoked）、agent 实例名与主机名（明文、
  非 secret）、完成时绑定 Login Identity/Employee Account、每实例同时只有一个有效 pending
  （新请求吊销旧请求）。
- `auth-core` 新增 `issueDeviceAuthorization`、`completeDeviceAuthorization`、
  `redeemDeviceAuthorization`；仓库层与审计事件（创建/完成/过期/吊销）同步实现。
- 路由：`POST /oauth/device_authorization`、`GET /oauth/device/verify`、
  `POST /oauth/device/verify/login`、`POST /oauth/token` 增加 device_code grant 分支；OAuth
  metadata 增加 `device_authorization_endpoint` 与 device_code grant。
- 验证页：agent 实例名/主机名配对信息、邮箱密码表单、成功页；短生命周期 host-only cookie +
  派生 CSRF；`form-action 'self'`，浏览器不留持久会话。

## Launcher 改动

- `LAUNCHER_VERSION` 升到 0.2.0；`oauth-client` 增加设备授权请求与轮询，处理
  `authorization_pending`、`slow_down`、`expired_token`。
- 登录统一走 device 流程：可开浏览器时自动打开链接，否则返回链接给 agent。
  `enterprise_hub_login` 立即返回 `{flow, verificationUriComplete, userCode, instanceName,
instanceHostname, openedBrowser}` 并在后台轮询；业务 MCP 调用有界等待会话就绪，超时返回
  `AUTHENTICATION_PENDING`。
- `session` 增加存储抽象：有 secure store 用 Keychain/Credential Manager（现状不变），
  `secureStore.available=false` 时纯内存态——不落盘、进程重启后重新登录、logout 只清内存。
- self-check/logout/typed conditions 契约不变。

## 文档与技能

- 提交本计划文档（PR 描述标注为 requested artifact）。
- repo-local `skills/enterprise-hub-mcp/SKILL.md` 更新 device 流程登录说明、B/C 投递方式与
  内存态重登提示；技能 pin 与 launcher 版本门槛在本 PR 不动；设计文档 In-Progress 小节同步
  为“实现中”。

## 测试计划

1. 服务端单元测试：metadata/契约、pending-login 生命周期（只存哈希、同实例吊销旧的、10 分钟
   过期、绑定身份、消费作废、`authorization_pending`/`invalid_grant`）、验证页（配对渲染、
   CSRF、渐进冷却、成功页无 secret）、会话（30 天会话族、10 分钟 access token、重放吊销）。
2. Launcher 单元测试：流程选择（可开/不可开浏览器）、后台轮询（5 秒、`slow_down` 退避、
   pending 到期）、内存态重启后 `AUTHENTICATION_REQUIRED`、存储抽象（Keychain 轮换/单飞锁、
   内存模式不落盘）。
3. 本地集成（真实 MySQL+Qdrant，`MYSQL_PORT=3307`）：内存态 launcher → 返回链接 → 表单
   POST 完成验证页 → 轮询拿 token → MCP 工具调用成功 → 重启 launcher 后需重新登录；安全负例
   （重放、错误 user_code、过期、错误 client_id）；桌面回归。
4. 无头环境验证：Linux 容器（无 DISPLAY、无 keyring）跑 `scripts/test-device-login.ts`，
   self-check 报 `secureStore.available=false`，login 不弹浏览器，员工端表单/headless 浏览器
   完成，重启后需重新登录；收尾删除容器/卷。
   已执行（2026-08-07）：在 `node:22-slim` 容器内跑通，`secureStore.available=false`、
   `openedBrowser=false`、device 链接正常返回；同时发现并修复 launcher 在无 keyring 主机上
   `AsyncEntry` 构造即抛 `PermissionDenied` 的问题（改为惰性构造，首次使用失败即落入内存态）。
   完整闭环已跑通（2026-08-07）：给 seed 员工设置真实密码后，无头容器内 launcher 生成 URL →
   脚本模拟员工在验证页输入真实密码完成 → launcher 后台轮询成功换到 token → 通过 launcher
   调用 `enterprise_hub_list_labels` 业务工具成功（`device_full_loop`）。
5. 人工验收（发布阶段，不在本 PR）：扩展 `npm run test:official-manual`，staging + 合成账号
   C 形态真机手机浏览器完成 device 登录。

## PR 与发布步骤

1. 更新本地 main（拉取 PR #106）并创建 `codex/device-code-login`。
2. 实现并补齐测试；本地全量门禁通过：typecheck、lint、format:check、test、
   `set -a; source .env; set +a; MYSQL_PORT=3307 npm run test:integration`、MCP 冒烟。
3. 提交（含计划文档）→ push → `gh pr create`（范围、测试清单、环境变更、人工输入、已知
   限制、diff 构成报告，标注计划文档为 requested artifact）→ 等 quality gates 全绿交付 review。
4. 合并后单独发布：launcher 0.2.0 上 npm → 服务端 metadata recommended 升到 0.2.0 → 同步
   更新 repo-local 与 standalone `enterprise-hub-mcp-skill`（standalone 单独 PR）→ 扩展官方
   人工验收 C 场景。

## 假设与默认值

- 单个实现 PR；launcher 发布与 standalone 技能仓库更新为合并后步骤。
- 服务端 metadata 的 minimum 保持 0.1.0、recommended 保持 0.1.1，0.2.0 门槛随发布生效。
- pending 10 分钟过期、轮询 5 秒 + `slow_down` 退避、每实例一个有效 pending、链接用
  `verification_uri_complete`、浏览器不留会话。
- agent 实例身份为 launcher 声明的主机名/实例名（客户端声明元数据）；不新增 per-IP 防滥用
  限制。
- 内存态会话不做跨进程共享、不引入协调文件；30 天服务端会话上限与密码重置全量吊销不变；
  会话清单 UI 维持 deferred。
