# SMEDC 文档入口

普通文档只维护当前有效状态、契约或最终决策。同一主题存在替代版本时，保留唯一现行版本、删除旧版本并修复引用；实施阶段不等于部署/激活阶段。历史资料不作为操作指令。

## 当前文档

| 主题                        | 权威入口                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品与领域术语              | [CONTEXT.md](../CONTEXT.md)                                                                                                                                                                                                           |
| 开发与阶段边界              | [实施计划](implementation/implementation-plan.md)、[开发说明](../README.md)、[中文说明](../README.zh.md)                                                                                                                              |
| HTTP/MCP 公共契约           | [API 契约](implementation/api-contract.md)                                                                                                                                                                                            |
| 成本卡 CSV＋目录            | [当前设计与实现合同](implementation/cost-card-design.md)；已合并，发布与部署证据见 staging 状态                                                                                                                                       |
| 资料与处理管线              | [检索和导入](implementation/data-pipelines.md)、[经营分区](implementation/structured-partitions.md)                                                                                                                                   |
| 业务权限最终决策            | [权限设计](implementation/business-related-authorization-design.md)、[场景说明](implementation/business-related-authorization-guide.md)                                                                                               |
| 企业准备和启用              | [入驻流程](implementation/tenant-onboarding.md)、[授权切换](implementation/business-authorization-cutover.md)                                                                                                                         |
| 管理界面与代办              | [UI 设计](implementation/admin-permissions-ui-design.md)、[内部权限 CLI](implementation/internal-permissions-cli.md)                                                                                                                  |
| 网页前端（未部署）          | [迁移实施计划](implementation/web-frontend-migration.md)（后端接口已迁移，前端在 `SMEDC_FRONTEND`，未部署）、规格 [Issue #319](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/319)                                          |
| 员工安装与登录              | [正式登录说明](implementation/official-user-install-and-login.md)、[MCP 流程](implementation/mcp-user-flow.md)、[中文流程](implementation/mcp-user-flow.zh.md)                                                                        |
| Skill 维护                  | [三仓维护与版本归属](implementation/smedc-mcp-skill.md)、[基础 Skill](../skills/smedc-mcp/SKILL.md)                                                                                                                                   |
| 存储与环境                  | [OSS 适配器](implementation/oss-designs.md)、[环境变量](implementation/env-inventory.md)                                                                                                                                              |
| staging 运维                | [最新验证状态](implementation/staging-readiness.md)、[部署手册](implementation/staging-deploy-runbook.md)、[主机前提](implementation/server-runtime-prerequisites.md)                                                                 |
| 数据库与台账                | [数据库诊断](implementation/database-diagnostics.md)、[PDF 运维](implementation/ledger-pdf-operations.md)、[保质期维护](implementation/ledger-shelf-life-maintenance.md)                                                              |
| 台账 PDF 网页（源码已实现） | [权威规格 Issue #262](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/262)、[已确认交互设计](implementation/ledger-pdf-download-center-design.html)、[实施计划](implementation/ledger-pdf-download-center-implementation.md) |
| 测试与交付                  | [测试入口](implementation/test-cases.md)、[正式人工验收](implementation/official-manual-acceptance.md)、[Beta 就绪条件](implementation/beta-access-readiness.md)、[开户手册](implementation/beta-user-onboarding-runbook.md)          |
| 依赖风险                    | [当前风险政策](implementation/dependency-risk-register.md)                                                                                                                                                                            |
| 使用场景                    | [Use Cases](context/use-cases.md)                                                                                                                                                                                                     |
| 已确认但尚未实现的功能      | [Skills Shop](implementation/skills-shop.md)；只按明确决策规划，不视为已上线能力                                                                                                                                                      |

平台外卖订单 `takeaway_orders` 已在源码实现，launcher `0.15.0` 尚未发布；契约见[经营分区](implementation/structured-partitions.md)，来源规格见 [Issue #293](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/293)。发布、部署及租户授权须独立确认。

## 已确认的自动工作流设计（尚未实现）

可分发企业工作流、已结账来源口径和换机接管的权威规格为 [Issue #298](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/298)。[图解使用指南](guides/automation-user-guide.html) 面向餐饮管理人员，说明功能完成后的首次安装、旧版更新、已有设置复用及换机步骤，不代表当前已经上线。

## 已确认的员工档案与正式门店设计（尚未实现）

[ADR 0028](adr/0028-employee-directory-store-identity.md) 记录员工档案授权、目录、离职交互与门店正式名称规则。实施与验收以 [Issue #327](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/327) 为准。

## 已确认的菜品目录与部门名称设计（尚未实现）

[ADR 0029](adr/0029-dish-catalog-current-state.md) 记录菜品目录从追加式快照改为当前状态并由批量 MCP 接口维护；[ADR 0030](adr/0030-department-name-uniqueness.md) 记录部门名称在同一业务企业内唯一。规格以 [Issue #337](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/337) 为准；实现边界、公共契约、迁移顺序与测试面见[实施计划](implementation/dish-catalog-current-state.md)。

## 历史与过程记录

这些文档保留当时的决定或验证证据，允许出现旧版本、撤回方案和当时尚未完成的工作。执行当前任务必须回到上表。

- [进度与里程碑](implementation/progress.md)、[早期交接里程碑摘要](implementation/agent-handoffs.md)。
- [ADR 决策记录](adr/README.md)、[早期设计问答](context/question_response.md)、[权限设计审阅记录](implementation/business-related-authorization-review.md)。
- [分区性能测量](implementation/dishes-business-partition-benchmark-2026-09-15.md)、[检索 V2 评估](implementation/evidence-retrieval-v2-evaluation.md)、[历次 staging 验证](history/staging-verification.md)。
