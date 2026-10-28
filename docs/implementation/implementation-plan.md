# SMEDC 当前实施范围与阶段边界

更新：2026-10-28。本文只记录当前已实现范围和仍需独立完成的阶段，不维护已完成任务的执行清单。

## 产品边界

企业资料中枢是员工自有 agent、MCP、CLI、API 的资料/数据底座，附带最小管理员权限界面。它不生成员工答案、经营报告或看板，不执行业务 Skill，不提供自然语言 SQL。当前领域定义见 [CONTEXT.md](../../CONTEXT.md)。

## 当前实现

| 领域 | 已实现范围 | 契约入口 |
| --- | --- | --- |
| 身份与客户端 | 第一方密码设置/登录、Device Authorization、不透明 token、轮换 durable session、官方 stdio launcher | [安装登录](official-user-install-and-login.md) |
| 普通文档 | MD/TXT/DOCX 解析、版本化混合检索、重排/相关性裁剪、按页原件链接 | [处理管线](data-pipelines.md) |
| 经营、菜品销售与店内已结账订单 | launcher multipart 原件传输、worker 原子发布 OSS 当前门店日分区、授权清单及本地校验下载 | [分区契约](structured-partitions.md) |
| 其他结构化资料 | 会员、菜品目录、供应商目录的受控查询和原件关联；配送台账仅内部输入 | [API 契约](api-contract.md) |
| 检疫证明与台账 | 单门店照片、独立 PDF 权限、计划生成/修复、覆盖与 ZIP 下载 | [PDF 运维](ledger-pdf-operations.md) |
| 成本卡 | 原件校验、逐卡 CSV 与 MySQL 目录、受权本地下载、归档/恢复 | [成本卡设计](cost-card-design.md) |
| 门店评价 | 平台评价事实批量同步、replyStatus 与可选 feedbackId、受权查询 | [API 契约](api-contract.md#store-reviews-launcher-0110) |
| 企业权限 | 当前账号密级及完整业务 grant、类别/维度/门店配置、本人权限卡、版本化管理与审计 | [权限设计](business-related-authorization-design.md) |
| 企业管理入口 | 企业专属 UI、共享浏览器身份、默认中文/English、内部代办 CLI | [入驻流程](tenant-onboarding.md) |
| 发布与运维 | main 质量门禁、不可变镜像、GitHub staging Environment、前向迁移、镜像回滚 | [部署手册](staging-deploy-runbook.md) |

这些能力已存在于当前源码。`settled_orders` 使用候选 launcher `0.14.0`，发行及服务部署待独立核验；订单能力需要未来已验证的 `0.14.0+`、匹配服务与当前类别授权，现行安装 pin 和推荐仍为 `0.13.1`。代码合并、launcher 发布、服务部署、某租户的配置/激活和正式业务验收分别取证，不互相替代。最近已验证的部署/公开版本见 [staging 状态](staging-readiness.md)。

## 阶段边界

- Phase 1：基础 API、MySQL/对象存储、账号与审计，已内化为当前服务基础。
- Phase 2：MCP/官方客户端，当前使用统一 HTTP 服务与本地 stdio launcher。
- Phase 3：检索与结构化数据能力已实现；行为以当前 API、管线及权限文档为准。
- Phase 4：staging 交付管线可用；客户级上线仍受恢复演练、告警、数据处理审批、租户激活和客户验收约束。
- Phase 5：扩大运营、可靠性治理和产品能力需另行确认范围。Skills Shop 的已确认决策不授权实施或上线。

## 权限切换

按 [准备/启用手册](business-authorization-cutover.md) 为每个组织单独处理。部署新增 schema/代码不会自动生成业务授权、推断历史属性或启用真实企业。

新读取在 enabled 模式按当前完整业务规则执行；准备模式和安全暂停遵守已实现的显式模式边界。旧查询游标、旧下载清单和签链使用当前版本校验，不通过兼容回退放宽权限。原始配送台账保持内部生成用途。

## 验收前提

官方人工验收运行器使用 0.13.1，支持选定只读检查，并核对原台账汇总的精确拒绝码。完整验收前须通过 `--evidence-config` 提供显式类别及完整 scopes，并确认目标租户配置；抽查通过不等于完整验收。当前说明见 [验收配置](official-manual-acceptance.md#current-runner-limitation)。

## 验证与发布

开发时执行变更相关的最小测试；最终树执行格式、lint、typecheck、单元测试及变更所需集成检查。具体命令、环境前提和清理规则见 [测试入口](test-cases.md) 与仓库 AGENTS.md。

- MCP 行为/契约变更同时更新 launcher、打包对齐测试及双归属 Skill；发布并独立验证后才修改推荐版本与安装 pin。
- 正式服务发布使用 main 质量门禁后的 `npm run deploy:staging`；PR 不部署，回滚不逆转 Prisma 迁移。
- runtime/性能改动先证明本地正确性，再在获准部署后以相同 fixture/workload 比较 staging。
- 完整官方人工验收只在明确请求时执行；发布授权不包含真实租户回填、激活或完整验收。
- 历史里程碑与当时的验收证据保留在 [progress](progress.md)，不在本文重述旧清单。
