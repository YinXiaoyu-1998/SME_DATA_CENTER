# 设备码登录成为唯一官方登录流程

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

**Status**: implemented in launcher 0.2.0; amended 2026-09-26 to remove the superseded flow

桌面 launcher 原本依赖 Authorization Code + PKCE + loopback 回调，只适用于有本机浏览器的
macOS/Windows。产品决定支持手机遥控的桌面 agent（支持类 B）和无头远端 agent（支持类 C），
因此官方登录流程统一改为 OAuth Device Authorization Grant（RFC 8628），使登录与客户端形态
无关。

**Decision**: launcher 通过标准 device authorization 流程获取第一方验证链接
（`verification_uri_complete` 预填 `user_code`）；支持类 A 由 launcher 自动打开浏览器，
支持类 B/C 由 agent 经员工通道投递链接；员工在任意设备的浏览器中输入密码并核对 agent
实例名称后完成授权，launcher 轮询 token 端点。0.2.0 起 device-code 是唯一登录流程；
2026-09-26 起服务端同时删除 Authorization Code + PKCE、loopback 回调和相关数据库表，
不再接受任何旧版登录协议。无安全存储的主机（支持类 C）使用内存态会话、不落盘
持久凭据；有 Keychain/Credential Manager 的 A/B 保持持久会话。细节见
`docs/implementation/official-user-install-and-login.md` 的 Current Official Device
Authorization Login 小节。

**Considered Options**:

- 混合流程（A 保留 loopback，B/C 用 device-code）：需要维护两套登录路径，且 B 在员工不在
  PC 前时无法完成登录。
- 统一保留 loopback：C 形态没有本机浏览器，无法工作。
- 私有“发链接 + 轮询”协议：安全性依赖自创细节，不如采用经过审查的标准。

**Consequences**:

- 服务端已新增 device authorization 端点、验证页（移动友好、含配对确认）和轮询 token grant；
  launcher 统一使用该登录流程，仅依据 `secureStore.available` 区分持久/内存会话模式。
- 配对确认依赖客户端声明的 agent 实例元数据，beta 阶段接受此局限。
- C 主机上 launcher 进程重启后需要重新点链接登录。
- 历史文档可以记录 loopback 曾经存在，但不得把它描述成当前兼容能力或运行路径。
