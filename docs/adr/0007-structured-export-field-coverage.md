# 完整覆盖结构化导出字段但逐字段限制查询能力

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

Phase 3 的菜品数据和营业数据必须完整覆盖当前真实导出的列集合。MySQL 表和结构化 API 字段注册表都要包含这些字段，避免出现“文件里有数据但员工智能体无法发现或请求”的产品缺口。

**Decision**: 采用完整但能力受控的字段注册表。每个真实导出字段都有稳定的 canonical API 定义和原始表头 alias，但过滤、排序、聚合、分组、`contains`、默认返回、显式选择、脱敏、索引和取值限制都必须逐字段声明。对外 API 仍是受控 JSON query-wrapper，不接受 SQL 或任意表达式。

Phase 3 同时提供结构化 schema discovery API，例如 `GET /structured/datasets`，返回 API/schema version、dataset 级限制、字段定义、capabilities、operators、敏感度、生命周期、索引状态和 deprecation metadata。调用方智能体必须基于 discovery 构造查询，不能仅因字段存在就假设它支持过滤、排序、聚合或分组。

显式聚合是机械查询能力，不是指标层或分析服务。完整字段覆盖不代表完整聚合能力；`groupBy`、`aggregateInput`、允许函数、单位/scale、基数限制、索引要求和敏感字段审计都必须逐字段声明。

**Considered Options**: 只存储完整导出但公开较小查询子集；将所有字段以完全相同能力公开；只实现常用 demo 字段。

**Consequences**: 完整字段覆盖满足产品对真实导出可用性的要求，也避免 demo 化实现；同时通过逐字段能力、敏感度、兼容状态、索引状态和查询复杂度限制控制 API 面积、性能和安全风险。代价是字段注册表、schema discovery、测试矩阵和兼容性维护成本更高；新增或变更导出列必须经过字段注册和能力评审。调用方智能体需要基于 discovery 校验 query 模板。Phase 3 可以返回机械聚合结果，但不提供公式、窗口函数、跨 dataset join、派生业务指标、趋势判断或自然语言分析。
