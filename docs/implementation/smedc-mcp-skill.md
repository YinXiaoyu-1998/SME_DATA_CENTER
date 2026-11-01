# MCP Skill 维护契约

`skills/smedc-mcp/` 与独立仓库 `YinXiaoyu-1998/smedc-mcp-skill` 的分发目录必须逐字节同步。Skill 只指导员工自有 agent 使用官方 launcher/MCP；它不包含服务部署、数据库读取、凭据管理或业务报告执行器。

## 当前安装与版本

当前批准安装 pin 以核心 [SKILL.md](../../skills/smedc-mcp/SKILL.md) 为准；源码最低版本见 [正式登录契约](official-user-install-and-login.md)，已核实线上策略见 [staging-readiness](staging-readiness.md)。精确安装路径、宿主配置、更新清理和诊断字段只在 [SKILL.md](../../skills/smedc-mcp/SKILL.md) 及其 references 维护，本文不复制整套步骤。

- Node.js 22+，支持 macOS/Windows/Linux 当前用户安装；不自动安装 latest 或由 launcher 自更新。
- 修改前备份宿主 MCP 配置，只修复 SMEDC 条目并保留其他集成；无法确定安全配置方式时报告具体阻塞。
- Device Authorization 的密码和协议 token 不进入 agent/model。无可用安全存储的宿主使用内存会话；不可将凭据写入普通文件。
- 当前账号/权限向服务查询，不从缓存或配置推断。认证恢复最多重试原操作一次；权限拒绝不能触发登录循环。

## 业务指导边界

- 当前有效 admin 才能上传；在本地读取文件前执行角色预检，服务端仍为授权主体。
- 原件按确切字节交付。经营/菜品及订单的大文件使用 launcher 路径上传；数据修复属于服务或独立 workflow Skill。
- Evidence 明确类别、完整范围和逐文件等级；照片明确企业和单门店；固定类别使用服务端当前密级。缺失值不推断。
- 异步上传/打包只能按返回 ID 轮询；queued、pending 和失败不能当成完成或无数据。幂等键仅精确重放复用。
- 经营/菜品/订单分析使用受权分区下载；其他可读取数据集按 schema 的 canonicalName 查询。台账只通过 PDF 交付，员工不触发生成。
- 原件、片段、后台任务和下载链接遵守 [API 契约](api-contract.md) 的当前授权边界；不要保留旧规则的替代放行路径。
- 企业入驻默认引导已验证的企业专属 UI，内部 JSON 不作为客户门槛。账号/密码/真实回填仍留在运维边界。
- 退出、移除单宿主集成和完全卸载分别处理，不删除服务账号、业务数据、Node/npm 或其他 MCP 配置。
- Skill 目录只发现元数据，不在 SMEDC 服务内执行 Skill 或生成答案。

订单上传/范围下载/可选 ZIP、完整快照及支付 JSON 由[店内订单 reference](../../skills/smedc-mcp/references/in-store-orders.md)维护。当前源码 `in_store_orders` 与 `takeaway_orders` 要求尚未发布的 `0.15.0` 候选，店内订单包括全部来源状态；历史 `0.14.0` 使用旧名 `settled_orders`。批准安装 pin、推荐与正式验收版本仍是已验证 `0.14.0`，最低保持 `0.12.0`。新名称须等待兼容客户端发布和匹配服务迁移，不能从源码或 Skill 同步推断上线。

## 变更和验证

MCP 行为/契约/使用指导变更遵守 [共享发布规则](../../packages/mcp-contract/AGENTS.md)：同批更新服务端与 launcher 契约、测试和双归属 Skill；先发布并独立验证运行包，再更新推荐元数据和安装 pin。纯文档校正不修改运行时版本。

检查 Skill frontmatter、当前命令/字段、引用、双仓库文件字节一致性，以及现有 `scripts/smedc-companion-skill.test.ts` 和 `scripts/official-user-install-and-login.test.ts`。格式检查和 git diff --check 必须通过。测试 Skill 描述的运行行为使用既有 MCP 集成入口，不把 Skill 文本当作新增工具实现。

## 三仓职责与同步

| 仓库/目录                                                                                   | 维护内容                                                                    | 版本依据                                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SME_DATA_CENTER`                                                                           | 服务、launcher 源码、公共契约、设计/运维与发布证据；核心 Skill 的服务侧副本 | launcher package/runtime/contract 的版本对齐；线上事实只在 staging 状态记录                |
| [smedc-mcp-skill](https://github.com/YinXiaoyu-1998/smedc-mcp-skill) 的 `skills/smedc-mcp/` | 核心 Skill 分发，含所有 references、assets 和 agents 元数据                 | 与服务侧完整目录逐字节一致；安装 pin 由核心 SKILL.md 批准                                  |
| [smedc-companion-skills](https://github.com/YinXiaoyu-1998/smedc-companion-skills)          | 经营分析、台账交付和独立美团工作流                                          | 各 Skill 以来源 Git commit/子目录标识修订；使用核心 Skill 的安装 pin，不另定 launcher 版本 |

文档/Skill 修订没有独立的 launcher 语义版本，不为整理文档增加 npm 版本。
同步三仓不等于更新员工本机 Skill 或 launcher；安装、升级和宿主重载仍按请求范围完成。
用户技能默认安装到 `~/.agents/skills`，不要将维护者个人绝对路径写成通用安装前提。

### 同步检查

1. 比较两份完整核心目录的文件集合和内容；不能只比较 SKILL.md 或版本号。
   宿主专用说明（包括 dsh）也属于镜像目录，不能单边维护。
2. 核对 launcher 源码版本、已验证发行物、核心安装 pin、源码最低/推荐值；这些值的语义不同，
   最低版本不必等于推荐版本。线上值只按新的公开核验或部署证据更新。
3. Companion 按核心 Skill 的批准版本使用客户端；能力还需匹配服务部署与当前授权。
   缺失/过时前置项走核心更新流程，不使用 npm latest，也不从服务推荐值自动改安装 pin。
4. 运行上文的服务侧检查、独立核心仓库 `python3 -m unittest discover -s tests -v`、
   companion 仓库 `python3 scripts/validate_all_skills.py`。README 只维护导航、安装范围和版本归属，
   业务步骤留在各 Skill/reference。

### 成本卡分工

核心 [cost-cards reference](../../skills/smedc-mcp/references/cost-cards.md) 负责原件上传、受权目录、
同名消歧、逐卡 CSV 下载及清理；[成本卡设计](cost-card-design.md) 维护服务合同。
经营分析 companion 的 cost_cards 和 dish_name_association references 负责本地分析及名称候选匹配：
优先 matched_product_name，空或无匹配再用 product_name，多个候选保留歧义。
这些指导不增加服务端明细分析、利润报告或新的报表 runner。
