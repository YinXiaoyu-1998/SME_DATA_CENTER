# 店内已结账订单实施入口

权威规格：[Issue #283 — 支持店内已结账订单完整快照与结账方式 JSON](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/283)，标签 `ready-for-agent`。业务设计及测试边界已确认；类别、解析和上传→原子发布→授权本地 CSV/ZIP 链路已在当前源码实现，候选 launcher 为 `0.14.0`，发行和匹配服务部署仍待独立核验。本文仅保留实施拆分和代码定位，不复制完整规格。

实现以 `main` 为基线。领域术语见 [CONTEXT.md](../../CONTEXT.md)，既有架构及生命周期见[经营分区契约](structured-partitions.md)。按根规则保持单一实现主线、比例适当的测试和一次完整交付核查。

## 实施批次与代码定位

| 批次                  | 实施内容                                                                                                   | 现有入口                                                                                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 数据类别与格式适配 | 扩展共享类别/字段注册；接入 30 列来源、订单占位符及结账方式原文＋派生 JSON；复用流式分区导出               | [字段注册](../../packages/domain/src/structured-registry.ts)、[分区身份](../../packages/domain/src/structured-partitions.ts)、[分区导出](../../packages/structured-ingestion/src/partition-export.ts)、[固定业务类别](../../packages/db/src/fixed-business-categories.ts)                                 |
| 2. 公共链路贯通       | 将新类别接入现有上传、目录原子发布、覆盖、完整权限、任务状态及下载；按需扩展既有目录枚举，不建立订单行存储 | [分区仓储](../../packages/db/src/structured-partitions.ts)、[导入 worker](../../apps/worker/src/partition-import.ts)、[分区 API](../../apps/api/src/routes/structured-partitions/routes.ts)、[launcher 传输](../../apps/mcp-launcher/src/partition-transfer.ts)、[MCP 契约](../../packages/mcp-contract/) |
| 3. 验收与客户端交付   | 扩展已有公共链路验收和必要局部回归；同步 launcher 契约、版本对齐和双归属 Skill 使用说明                    | [集成入口](../../scripts/test-integration.ts)、[集成辅助](../../scripts/test-integration-support.ts)、[协调发布规则](../../packages/mcp-contract/AGENTS.md)、[Skill 维护契约](smedc-mcp-skill.md)                                                                                                         |

修改前读取上述模块各自适用的 AGENTS.md；公共规则仍由根及模块规则维护。需要实际发布或部署时另行遵守对应授权边界，不能以本实施文档代替操作授权。

## 已确认测试入口

- 主验收复用现有集成入口：launcher 上传合成 XLSX → worker 原子发布 → 当前权限校验 → 下载并独立读取 CSV/JSON。覆盖正常交付、失败不部分发布、重传覆盖、未出现门店日保持和必要授权拒绝。
- 新格式边界集中在[分区导出测试](../../packages/structured-ingestion/src/partition-export.test.ts)，按需扩展既有测试验证支付 JSON、原文、占位符、严格表头及编号。原子发布和权限优先复用[仓储集成测试](../../packages/db/src/structured-partitions.prisma.integration.test.ts)与[API 测试](../../apps/api/src/routes/structured-partitions/routes.test.ts)。
- 本地交付复用[launcher 传输测试](../../apps/mcp-launcher/src/partition-transfer.test.ts)及[打包测试](../../apps/mcp-launcher/src/partition-bundle.test.ts)。集成辅助中简单按逗号切分 CSV 的假设不适用于 JSON 字段，改用项目已有标准 CSV 解析能力。
- 使用小型合成 fixture，独立构造期望值；不提交真实客户数据。不新建测试框架、不做大规模压测或完整官方人工验收。
- 开发运行最小相关测试；实现最终树按根规则运行一次最终质量门禁及必要集成检查。环境准备、目标验证和清理遵守 [scripts 规则](../../scripts/AGENTS.md)。源码验证不代替发布、部署或真实租户验收；最终证据随实现 PR 交付。

## 交付边界

当前有效用法见[核心订单 reference](../../skills/smedc-mcp/references/settled-orders.md)。订单能力须等待未来已发布、独立验证的 launcher `0.14.0+`，匹配服务部署和当前类别授权。源码候选版本不改变全局最低 `0.12.0`、推荐及安装 pin `0.13.1`，不更新人工验收运行器 pin。

实现 PR 应引用 Issue #283，并提供已确认公共行为的测试证据、兼容性说明和分类 diff 行数。功能合并、launcher 发布、服务部署、企业授权和真实导入分别取证。基础实施不增加外部设施或环境配置；若发现需要实质扩大范围，先说明原因。
