# 设备码登录成为唯一官方登录流程

**Status**: implemented and released in launcher 0.2.0

桌面 launcher 原本依赖 Authorization Code + PKCE + loopback 回调，只适用于有本机浏览器的
macOS/Windows。产品决定支持手机遥控的桌面 agent（支持类 B）和无头远端 agent（支持类 C），
因此官方登录流程统一改为 OAuth Device Authorization Grant（RFC 8628），使登录与客户端形态
无关。

**Decision**: launcher 通过标准 device authorization 流程获取第一方验证链接
（`verification_uri_complete` 预填 `user_code`）；支持类 A 由 launcher 自动打开浏览器，
支持类 B/C 由 agent 经员工通道投递链接；员工在任意设备的浏览器中输入密码并核对 agent
实例名称后完成授权，launcher 轮询 token 端点。0.2.0 起 device-code 是唯一官方登录流程；
loopback Authorization Code 仅在服务端保留为 minimum-compatible 0.1.x 的兼容路径，不再是
技能固定、推荐或员工文档中的登录路径。无安全存储的主机（支持类 C）使用内存态会话、不落盘
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
- loopback 相关章节在文档中仅保留为 0.1.x 服务端兼容背景。
