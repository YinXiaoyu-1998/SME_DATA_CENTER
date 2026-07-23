# 用可撤销 Beta 访问令牌开放远端 MCP

**Status**: Proposed - pending product-owner approval

## Context

Phase 4 的部署骨架已经在线，但它仍然不是一个真实员工可以使用的服务：

- staging 以 `NODE_ENV=production` 运行，因此 `/auth/dev-login` 返回 `404`；
- `/mcp` 仍执行 Phase 3 的硬回环限制，公网请求返回
  `MCP_LOOPBACK_REQUIRED`；
- launcher 只能用邮箱调用 development login，并且只接受 base URL 配置；
- staging 只有 synthetic seed employee，没有真实 beta employee；
- Prisma 已有 `access_tokens` 表的过期、撤销和最后使用字段，但当前认证代码没有使用它。

当前目标不是一次性完成企业 SSO，而是让一名已知 beta 用户尽快、安全地从自己的
MCP client 调用远端服务，同时不重新开放“只知道邮箱即可冒充员工”的 development
login。

## Decision

Phase 4 beta 采用一个限时、可撤销的 opaque employee access token，作为完整
OIDC/SSO 之前的受控过渡方案：

1. operator CLI 创建或更新明确的 beta employee，并显式指定 role 与 label scope。
   默认不得授予 `admin`。
2. operator CLI 生成高熵 token；数据库只保存 token hash、employee、名称、过期时间、
   撤销时间和最后使用时间。明文 token 只在签发时出现一次，不写入 git、日志或聊天。
3. beta 用户通过本机交互式 login helper 把 token 放入操作系统 credential store。
   launcher 从安全存储加载 token；MCP 配置仍只包含 base URL，agent/model 看不到 token。
4. API 的统一认证层同时接受现有短期 JWT 和数据库支持的 beta token；两者都必须重新
   加载 employee，disabled employee、expired token 和 revoked token 立即失效。
5. nginx 仍是唯一公网入口，API 仍只绑定 `127.0.0.1`。`/mcp` 只在连接来自本机
   reverse proxy、原始 public host 为 `api.smedatacenter.xyz` 且 forwarded scheme 为
   HTTPS 时开放；开发环境继续保留现有 loopback-only 行为。
6. `/auth/dev-login` 在 production 中继续关闭。公开 `/readyz` 继续返回 `404`。
7. token 签发、撤销和认证使用进入审计；任何日志都不得包含 token、token hash 或
   Authorization header。

首轮 beta 先用 repo fixture 或经明确批准的非敏感资料完成远端闭环。真实业务资料只有在
恢复目标、删除/保留规则和最小告警闭环确认后才进入 staging。

## Consequences

### Positive

- 不依赖邮件服务或第三方 IdP 就能让第一名 beta 用户上线。
- 比共享 JWT 或重新打开 dev login 更容易撤销和审计。
- 复用既有 employee/label 授权模型以及已经存在的 `access_tokens` schema。
- 将来切换 OIDC/SSO 时，`POST /mcp` 的 bearer-auth contract 和业务工具无需改变。

### Negative

- 首次签发和凭据安装仍包含一次 operator/beta-user 交接。
- login helper 必须针对 beta 用户的操作系统安全存储实现并验证。
- opaque token 是过渡身份方案，不提供完整的企业 IdP 生命周期、MFA 或自动离职同步。

### Neutral

- token 默认建议 30 天过期；最终期限由产品负责人在首位 beta onboarding 前确认。
- beta employee provisioning 暂时使用 operator CLI，不提前实现 admin UI。

## Alternatives Considered

**立即实现 OIDC/SSO**

- 长期方向正确，但需要选择 IdP、注册 OAuth client/callback、设计浏览器/device flow，
  会显著推迟首位 beta 用户。

**重新开放 `/auth/dev-login`**

- 拒绝。任何知道已注册邮箱的人都能冒充该员工，不适合公网。

**由 operator 生成一小时 JWT**

- 拒绝作为 beta 流程。它没有独立撤销记录，过期后需要重复人工签发，也没有可用的安全
  launcher bootstrap。

**把长期 token 写入 MCP env/config**

- 拒绝。配置容易被 agent、日志、诊断包或截图读取，不符合 model-invisible credential
  边界。

## Follow-up

- beta 验证通过后，单独选择 OIDC/SSO provider 与登录协议；不要把 opaque beta token
  直接扩展为长期生产身份平台。
- 任何 launcher、MCP contract 或使用指导变化必须同步 repo-local 与 standalone
  `enterprise-hub-mcp` skill。
