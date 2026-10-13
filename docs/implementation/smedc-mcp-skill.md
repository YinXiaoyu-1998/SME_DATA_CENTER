# MCP Skill 维护契约

`skills/smedc-mcp/` 与独立仓库 `YinXiaoyu-1998/smedc-mcp-skill` 的分发目录必须逐字节同步。Skill 只指导员工自有 agent 使用官方 launcher/MCP；它不包含服务部署、数据库读取、凭据管理或业务报告执行器。

## 当前安装与版本

批准安装 pin 为 `smedc-mcp-launcher@0.9.0`，服务推荐 0.9.0、最低兼容 0.6.0。精确安装路径、宿主配置、更新清理和诊断字段只在 [SKILL.md](../../skills/smedc-mcp/SKILL.md) 及其 references 维护，本文不复制整套步骤。

- Node.js 22+，支持 macOS/Windows/Linux 当前用户安装；不自动安装 latest 或由 launcher 自更新。
- 修改前备份宿主 MCP 配置，只修复 SMEDC 条目并保留其他集成；无法确定安全配置方式时报告具体阻塞。
- Device Authorization 的密码和协议 token 不进入 agent/model。无可用安全存储的宿主使用内存会话；不可将凭据写入普通文件。
- 当前账号/权限向服务查询，不从缓存或配置推断。认证恢复最多重试原操作一次；权限拒绝不能触发登录循环。

## 业务指导边界

- 当前有效 admin 才能上传；在本地读取文件前执行角色预检，服务端仍为授权主体。
- 原件按确切字节交付。经营/菜品的大文件使用 launcher 路径上传；数据修复属于服务或独立 workflow Skill。
- Evidence 明确类别、完整范围和逐文件等级；照片明确企业和单门店；固定类别使用服务端当前密级。缺失值不推断。
- 异步上传/打包只能按返回 ID 轮询；queued、pending 和失败不能当成完成或无数据。幂等键仅精确重放复用。
- 经营/菜品分析使用受权分区下载；其他可读取数据集按 schema 的 canonicalName 查询。台账只通过 PDF 交付，员工不触发生成。
- 原件、片段、后台任务和下载链接遵守 [API 契约](api-contract.md) 的当前授权边界；不要保留旧规则的替代放行路径。
- 企业入驻默认引导已验证的企业专属 UI，内部 JSON 不作为客户门槛。账号/密码/真实回填仍留在运维边界。
- 退出、移除单宿主集成和完全卸载分别处理，不删除服务账号、业务数据、Node/npm 或其他 MCP 配置。
- Skill 目录只发现元数据，不在 SMEDC 服务内执行 Skill 或生成答案。

## 变更和验证

MCP 行为/契约/使用指导变更遵守 [共享发布规则](../../packages/mcp-contract/AGENTS.md)：同批更新服务端与 launcher 契约、测试和双归属 Skill；先发布并独立验证运行包，再更新推荐元数据和安装 pin。纯文档校正不修改运行时版本。

检查 Skill frontmatter、当前命令/字段、引用、双仓库文件字节一致性，以及现有 `scripts/smedc-companion-skill.test.ts` 和 `scripts/official-user-install-and-login.test.ts`。格式检查和 git diff --check 必须通过。测试 Skill 描述的运行行为使用既有 MCP 集成入口，不把 Skill 文本当作新增工具实现。
