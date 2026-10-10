# 业务权限与原文件权限实施计划

> **For agentic workers:** 后续获准实施时以 `superpowers:subagent-driven-development` 为中心执行，默认模型 `gpt-6.1-sol`、reasoning effort `high`。9 个批次按下文分成 3 个审查组，不逐批派 review agent；发现此前未讨论的重大复杂性立即停止执行并请用户确认。全部实现和最终验证完成后才提交完整实现 PR，中途不得合并任何未完成 PR，尤其不得合并到 `main`。本轮只修订计划，不执行实现步骤。

**Goal:** 将已经定稿的业务授权统一落到服务端所有读取入口、权限管理、数据发布和迁移流程。

**Architecture:** MySQL 保存权威类别、授权、资料完整范围及版本，领域层提供统一匹配语义，查询层把相同语义编译到数据库过滤中。HTTP 是权限执行边界，MCP 复用 HTTP；后台任务按受理清单制作，签发新链接时重新读取当前权限。按企业准备并原子启用新模型，避免逐入口切换产生旁路。

**Tech Stack:** 现有 TypeScript、Fastify、Prisma/MySQL、Qdrant、对象存储、Vitest、官方 MCP launcher；不预设新增依赖或新服务。

**Spec:** [业务权限与原文件权限设计](business-related-authorization-design.md)。设计 PR [#225](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/pull/225) 已合并，基线 `main@dfe549a33bb2e6024299d538fb4283bfccf04baa`；实施启动时重新同步 `main` 并核对并行改动。

日期：2026-10-10。状态：实施计划，尚未执行。现有运行行为不会因本文合并而改变。

## Global Constraints

- 维持资料/数据服务定位；不建设完整管理网页、员工 AI、报表、看板、SQL 代理或 Skill runner。遵守 [总实施计划](implementation-plan.md) 的 Phase 3/4 边界，不启动 Phase 5。
- 当前有效同企业账号、当前密级、明确类别、完整实际范围、资料有效性必须同时满足；admin/上传者身份均不是普通读取通行证。
- 账号密级为统一 0–3；admin 创建时默认 3，employee 必填；新账号默认无业务授权，开发开户可显式给予初始授权并审计；角色变更不重置授权或密级。
- `business`/`dishes` 仅当前 OSS 分区，不恢复逐行查询/聚合或原始 Excel 留存；`vip`、`dish_catalog`、`supplier_catalog` 为集团级。原始 `delivery_ledger` 对员工关闭明细、汇总及原件，但保留内部导入/生成。
- 门店按企业内持久化名称精确匹配；不做相似度、自动别名或商户号授权旁路。固定 A/B 不随新店扩张；动态全部不扩张类别、归属类型或新增必需维度。
- 保留原件自动继承成功解析的全部数据要求。只解析 A，未识别部分随 A；解析 A/B，整件须覆盖 A/B。没有额外原件定权、完整解析门槛或管理员确认步骤。
- 每张检疫照片和每份 PDF 恰好一家门店。PDF 独立授权；来源读取权限变化不影响成品有效性，照片内容/关联/有效性变化才触发失效和每日重做。
- 打包采用提交鉴权、固定清单制作、签新链接鉴权；不增加撤权监听、活跃任务扫描或中途撤权失败。已签发链接保留原 TTL，原件仍为 24 小时。
- 准备期旧模型与启用后新模型明确分开；不得按旧/新任一通过即放行。回退不能恢复已经撤销的读取能力。
- 本轮不修改运行代码，不执行数据库迁移、真实资料回填、npm 发布或部署。后续这些执行动作仍遵守独立授权边界。

## Review Focus

以下五项在各责任批次增加小型回归用例，不另建全组合矩阵：

1. MySQL 默认大小写/尾空格比较与现有门店键不一致：名称授权不得意外合并不同持久化名称；批次 1、3、4 验证。
2. 来源行被新批次替换后，旧原件只剩部分可见关联：原件不能因查询当前行或员工可见行而缩小权限要求；批次 3、4 验证。
3. evidence 权限收紧但 Qdrant/缓存仍旧：受限正文不得进入 rerank，也不得被引用或自动原件链接带出；批次 5 验证。
4. 权限改变被误当成内容改变：不能触发 PDF 重生成，不能把成功下载任务改成失败；批次 6、7 验证。
5. 切换与并发管理/导入相遇：过期准备结果不能启用，任何新模型请求不得回退旧权限，回滚不能恢复旧读取；批次 2、8 验证。

## 实施组织与交付边界

### Subagent-driven 执行与模型

主 agent 负责协调、依赖与验收，implementation subagent 负责分组实现，独立 review subagent 在约定组边界检查规格符合性及代码质量。主 agent 不代替 subagent 执行整套实现，也不把 subagent-driven 等同于强行并行。

- **默认配置：** 所有 implementation/review subagent，包括最终全分支 reviewer，显式指定 `model: gpt-6.1-sol`、`reasoning_effort: high`，不省略参数继承其他模型。使用隔离上下文并提供设计、所属批次、共享接口、文件所有权及已有验证结果。用户后续指定优先；默认配置不可用时使用最接近的支持配置并明确报告，不静默替换。需要主动升级模型或扩大 agent 数量时先说明原因并确认。
- **所有权与隔离：** 每个实现组由一个 implementation subagent 顺序完成，使用自己的隔离 branch/worktree；从集成分支最新已验收提交开始，组内复用上下文。修复优先交回该实现者。组间按依赖串行移交；只有文件所有权和接口均独立的工作才考虑并行，不安排多个 agent 同时改同一文件。只读 reviewer 无需独立 worktree。
- **批次内动作：** 每批补关键失败用例、实现、运行聚焦测试、做简短实现者自检并提交。下文“自审”仅指实现者检查自身改动，不代表独立 review，不新增 reviewer、独立规格审查或全库测试。
- **流程优先级：** 本节是用户明确指定的 SDD 调整，覆盖技能中逐 task review、默认模型选择、遇到重大未决问题仍自行裁决继续以及提前进入分支收尾的通用建议。不得套用这些默认流程绕过下述停止和 PR 边界。

### 分组审查，不逐批 review

批次依赖仍为 `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9`，共安排 **3 次独立审查节点**：

| 审查组                | 实现批次 | 完成后的一次审查范围                                                               |
| --------------------- | -------- | ---------------------------------------------------------------------------------- |
| A：权限基础与资料属性 | 1–3      | 权限匹配、管理边界、完整范围与原件关联；一次 review 同时检查规格与代码质量         |
| B：读取与交付         | 4–7      | 结构化/evidence/PDF/原件/打包全链路，重点检查上游来源权限与成品权限是否混淆        |
| C：切换与最终集成     | 8–9      | 在审查本组的同时，对批次 1–9 的完整分支做最终集中审查；不另加第四次重复全量 review |

组 A、B 的阻塞问题解决后才进入下一组；组 C 阻塞问题和最终门禁失败全部解决后才能交付。修复后的复审只检查修复差异及受影响路径，不重审未改代码，也不重跑已通过且不受影响的测试。实现者不得自行再派 reviewer。若出现需要提前审查或显著扩大复审范围的新重大风险，按下一节立即停止并说明，不悄悄增加审查轮次。

### 重大新复杂性：立即停止，先确认再继续

**执行中发现此前未讨论的、比较重大的复杂性，必须立即停止整项计划的实现执行，通知所有正在工作的 subagent 停止修改；保留现有工作，不自行选择重大设计或执行方案后继续。** 不必等到所有可行路径都不确定才停。

例如：现有数据无法按已定规则建立可靠权限关联；需要改变授权语义或迁移/回退方案；必须引入新服务、存储体系或明显超出预期的重构；跨系统契约不兼容；工作量、PR 体量或发布依赖出现重大增长。正常的局部 bug、既定测试失败且修法不改变设计/范围时可按原计划修复，不为每个小问题打断用户。

停止后向用户说明：发现的事实与证据、为何原计划不能直接覆盖、影响哪些批次与成本/风险、需要核实确认的设计选择或执行抉择、可选方案及建议。只做说明所必需的只读核实，不继续实施或通过增加 agent/重构来绕过去；等待用户明确决定，更新计划后再恢复。

### 完整 PR 交付与禁止中途合并

采用一个服务端/launcher 集成分支。实施过程中可在隔离分支提交或备份，并将已验收组的提交整合到该 feature 集成分支；这不代表允许创建分批实现 PR 或将部分成果合并到共享基础分支。

**必须等批次 1–9 全部实现、分组/最终审查完成、最终质量门禁通过后，才创建一个包含完整实现的主仓库 PR 供用户审阅。不得在执行过程中合并任何只完成部分计划的 PR，尤其不得合并到 `main`；不得自动合并、先合并后补功能、提前发布或部署。** 如有现存草稿实现 PR，也不得中途合并；本轮计划文档 PR 不代表已开始实现。

两份基础 Skill 仍遵守仓库要求，在全部实现就绪时配套提交独立仓库的完整分支/PR，与主 PR 一起交付审阅，不把伴随仓库当作提前合并未完成工作的例外。若认为必须拆分实现 PR，按重大复杂性流程停止并请求用户决定，未获新指示前仍保持完整交付约束。

这里“计划完整执行”指 9 个实现批次及 PR 前的审查、验证全部完成；下文发布/部署/真实企业切换是用户审阅完整实现 PR 后、另行授权的阶段，不提前执行来满足完成条件。只有 launcher 已获准发布并独立核验后，才按既定发布边界更新推荐版本和双份 Skill pin；该顺序不得用于拆出未完成实现提前合并。

## 文件职责和统一接口

以下新增文件名是计划接口；既有文件路径已按当前仓库核对。实现时允许必要的小范围整合，不创建通用策略 DSL 或复制多套权限引擎。

| 文件/目录                                                                                                                                      | 职责及变化                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 新增 `packages/domain/src/business-authorization.ts`                                                                                           | 纯权限类型、完整 grant 匹配、范围校验和明确拒绝原因；由 `index.ts` 导出                            |
| 新增 `packages/db/src/business-authorization.ts`、`business-authorization-sql.ts`                                                              | 当前权限快照、原子写入/审计、当前类别密级解析及受控 SQL 谓词；更新包导出                           |
| `packages/db/prisma/schema.prisma` 及新 migration                                                                                              | 企业启用状态/版本、类别与维度、账号 grant、evidence 属性、来源解析范围及照片门店；兼容准备期旧数据 |
| 新增 `apps/api/src/business-authorization.ts`、`routes/business-authorization.ts`                                                              | 请求级读取当前快照、权限名片、admin 管理及准备/启用 API                                            |
| `apps/api/src/app-context.ts`、`server.ts`、`request-auth.ts`、`employees.ts`                                                                  | 接入统一服务与当前账号；不把 token 内旧值当授权真相                                                |
| `apps/api/src/routes/structured-import/`、`structured-imports.ts`；`apps/worker/src/worker.ts`、`partition-import.ts`                          | 导入发布前确定完整业务属性；保存原件全部成功解析范围的可追溯关联                                   |
| `packages/domain/src/structured-query.ts`、`structured-coverage.ts`、`structured-ledger-policy.ts`；`packages/db/src/structured-partitions.ts` | 查询、coverage、分页与当前分区在授权集合内执行，关闭原台账公开查询                                 |
| `apps/api/src/routes/structured-query.ts`、`routes/structured-partitions/`、`source-documents.ts`、`source-document-downloads.ts`              | 目录、manifest、显式整件下载与签发入口统一授权                                                     |
| `apps/api/src/evidence.ts`、`routes/evidence.ts`、`documents.ts`；`apps/worker/src/evidence-index.ts`                                          | 整份 evidence 属性与检索片段一致，索引旧值不得扩大读取                                             |
| `apps/api/src/quarantine-certificates.ts`、`routes/quarantine-certificates.ts`；`packages/ledger-archive/src/`                                 | 单店照片、PDF 独立授权、内容指纹和每日修复                                                         |
| `packages/db/src/partition-downloads.ts`、`packages/ledger-archive/src/delivery.ts`、`repository.ts`；两类 worker processor/bundle             | 固定制作清单；拆分完整性、状态读取与领链接鉴权                                                     |
| `packages/mcp-contract/src/index.ts`、`apps/api/src/mcp/`、`apps/mcp-launcher/`                                                                | 官方工具参数、权限管理、错误语义、版本与包对齐                                                     |

领域层公开类型采用以下含义，供各批复用：

- `BusinessScopeItem`：`enterpriseKey`（沿用现有资料企业边界）、`ownership: group | store`、门店归属时必填的 `storeName`、实际维度值 `dimensions: Record<string, string>`。范围项数组保留真实组合，不做笛卡尔展开。
- `BusinessGrant`：明确 `categoryIds`、企业边界、归属类型及各适用维度选择；每个选择是 `fixed(values)` 或显式 `all`。不得用类别通配符，也不得忽略不适用条件。
- `ResourceReadRequirement`：组织、类别、实际完整范围项、当前有效状态；密级来自类别当前配置或 evidence 当前文件属性。
- `AuthorizationSnapshot`：当前账号/角色/密级、grant、类别规则及企业授权版本。版本令牌由服务端生成，客户端不能指定权限快照。
- `canReadResource(snapshot, requirement): AccessDecision`：逐范围项找到一条完整 grant，同时检查账号、组织、类别、密级及有效性；拒绝原因可提供名称/概述，不能带正文或链接。
- `loadAuthorizationSnapshot(employeeId, orgId, tx?): Promise<AuthorizationSnapshot>`：请求内复用，跨请求重新读取权威配置；本期不用跨请求权限缓存。
- `compileAuthorizedScope(snapshot, target): { sql, params }`：只接受开发登记的目标映射，产生绑定参数的 SQL；与纯函数语义相同，SQL 先限权再业务筛选、排序、聚合和分页。
- `getSourceReadRequirements(sourceDocumentId, orgId, tx?): Promise<ResourceReadRequirement[]>`：读取原件全部成功解析范围及当前类别规则；无可确定要求时拒绝，不返回空集合代表公开。

身份比较不复用当前 `partitionStoreIdentity` 中的 `asciiLowercase` 作为授权键。使用持久化门店名称及精确比较；在 MySQL 中指定等价的二进制/无尾空格折叠比较。既有读取器已清理的名称不还原猜测，不改 OSS 物理键；新入库与授权表单引用同一名称目录值。

## 批次 1：权威权限模型与匹配语义

**范围：** 上述领域/DB 新模块、Prisma schema/migration、包导出。新增测试 `packages/domain/src/business-authorization.test.ts`、`packages/db/src/business-authorization.prisma.integration.test.ts`；扩展现有 `scripts/test-integration.ts` 的隔离数据库 runner，不另建测试 harness。

**输入/产出：** 产出统一类型、`canReadResource`、`loadAuthorizationSnapshot`、`compileAuthorizedScope`；后续批次不得另造“同组织密级够就可读”的兜底。

- [ ] 写失败用例：`requires_one_complete_grant_per_scope_item` 验证类别与门店分属两 grant 不能拼接；A/X、B/Y 不能扩出 A/Y；两个完整 grant 可分别覆盖共有资料。
- [ ] 写边界用例：无 grant、账号停用、跨企业、密级不足拒绝；会员集团级不要求门店；固定枚举与动态全部、新类别/新维度、退休门店历史访问分别符合设计；空门店拒绝，不同精确名称不合并。
- [ ] 增量建模：类别及维度定义/取值持稳定 ID；grant 和实际范围保存关联完整性；企业模式及单调递增版本持久化。证据类文件密级与固定类别密级分开；缺配置用未就绪状态，不默认 0/3/集团。
- [ ] 实现领域匹配、参数化 SQL 与仓储，在少量相同 fixture 上验证 SQL 和纯函数结果一致；账号/类别/grant/资料属性写入与版本递增同事务。内容版本和授权版本分别维护。
- [ ] 聚焦运行 `npx vitest run packages/domain/src/business-authorization.test.ts`；新增 DB 集成用 `RUN_BUSINESS_AUTHORIZATION_PRISMA_INTEGRATION=1 npx vitest run packages/db/src/business-authorization.prisma.integration.test.ts`，由既有 runner 分配本地隔离 `DATABASE_URL`，不得沿用客户/远程数据库。将此文件加入 runner 的最终集成调用；确认 PASS 且无应跑却跳过的案例。执行 `npm run db:generate` 及 `npm run typecheck` 验证新增接口。
- [ ] 自审 schema 组织外键/唯一约束、精确名称比较和查询语义，提交 `feat: add business authorization model`。

## 批次 2：权限管理、本人名片和管理生命周期

**范围：** 新增权限 API/service 及 `apps/api/src/routes/business-authorization.test.ts`；修改 `server.ts`、`app-context.ts`、`employees.ts`、`auth/operator-cli.ts`、`auth/prisma-auth-operator-repository.ts` 和对应测试；修改现有归档与上传会话取消路径。

**输入/产出：** 使用批次 1 快照。提供 `GET /v1/permissions/me`，admin 的 `GET /v1/admin/permissions/accounts`、`GET/PATCH /v1/admin/permissions/accounts/:employeeId`；PATCH 用 `expectedVersion` 原子更新密级及 grant。类别/维度目录在 `/v1/admin/permissions/categories`、`/dimensions` 下提供列表、创建和带版本更新/停用；固定类别仅允许管理已开放配置。evidence 属性通过管理文档属性接口修改，不创建结构化原件独立定权入口。

- [ ] 写失败用例：无正文权的 admin 能读/改所有同企业账号配置含本人；employee 只可读自己；跨企业、停用、旧版本写入拒绝；不返回正文/行/下载链接。
- [ ] 实现配置写入和审计原子性，校验多类别 grant 的条件共同适用；目录已有引用不可硬删/复用 ID，停用不撤销历史授权。创建 evidence 类别不会新增解析能力。
- [ ] 调整开户：admin 缺省密级 3、employee 必填、可选显式初始 grant 并审计；未指定 grant 为空。角色变更保留已有值，不扩张账号凭证管理给普通 admin。
- [ ] 统一已发布资料归档为当前 admin；历史上传者降为 employee 后不能归档。有效本人只可取消自己未完成上传会话，已受理处理、已发布/被引用内容不可借此删除；admin 管理状态与普通内容读取分离。
- [ ] 跑新增 route 测试、`apps/api/src/auth/operator-cli.test.ts`、`apps/api/src/documents.test.ts`、`apps/api/src/routes/quarantine-certificates.test.ts`、`apps/api/src/routes/structured-partitions/routes.test.ts`；验证审计前后值、冲突无部分写入及角色改变即时生效。自审后提交 `feat: expose permission administration and self profile`。

## 批次 3：资料属性、导入发布与原件关联

**范围：** structured import workflow/repository/worker、partition import、`packages/structured-ingestion/src/`、`quarantine-certificates.ts`、evidence 上传参数；新增 `packages/db/src/source-read-requirements.ts` 和同名 `.test.ts`，对应 Prisma 集成断言放批次 1 的集成文件。

**输入/产出：** 产出 `getSourceReadRequirements`。固定映射为经营/菜品销售门店级、会员/菜品目录/供应商集团级、配送台账内部单店、照片固定类别单店；evidence 明确类别/完整范围/文件密级。实际类别 ID 由受控映射解析，不信任客户端伪造种类。

- [ ] 写失败用例：只解析 A 加忽略工作表、解析 A/B、集团级会员、空门店、类别未配置、照片先于台账到达、照片与台账店不一致。
- [ ] 在成功导入事务中保存原件与全部成功解析类别/实际范围的去重关联，不取调用者可见子集；类别引用动态解析当前密级。历史原件关联不因当前窗口替换或行退出 current 而丢失；失败、零有效解析数据不能产生空授权公开原件。
- [ ] 上传/解析/发布分别校验职责：admin 可授权上传内部资料，worker 以内部身份继续处理；发布前所需属性完整，缺项保持未发布，不替换仍符合当前规则的有效资料。不再把结构化上传参数密级作为启用后权威值。
- [ ] evidence 新上传引用已存在类别，不暗中创建；照片写入恰好一个显式门店，receipt 仅关联业务，后到台账须验证同店。门店目录采用持久化精确名称，无相似度阻断。
- [ ] 跑 `apps/api/src/routes/structured-import/workflow.test.ts`、`apps/worker/src/structured-import.test.ts`、`apps/worker/src/partition-import.test.ts` 及新增来源测试；本地集成检查原件关联和发布同事务、回滚无残留。自审后提交 `feat: persist authoritative resource scopes and source lineage`。

## 批次 4：结构化查询、目录、分区与原件读取

**范围：** 表中 query/coverage/partition/source 路径及现有相邻测试；`packages/domain/src/structured-ledger-policy.ts`、`apps/api/src/routes/ledger-query-policy.test.ts`、`ledger-source-policy.test.ts`。HTTP 直连和 MCP 下游均使用同一结果。

**输入/产出：** 使用批次 1 SQL 与批次 3 原件要求；查询按授权子集返回，显式完整目标按全部要求判定。游标增加企业/账号及授权版本绑定。

- [ ] 写失败用例：仅 A grant 的账号查询 A/B 只得 A，聚合/计数/coverage/分页也只含 A；会员在 B 开卡 A 储值仍按集团级；名称业务筛选可模糊，但不能扩大精确名称授权。
- [ ] 将受控 SQL 判定接入行查询及当前分区选择；固定类别当前密级覆盖新旧行/分区，舍弃启用后上传批次旧密级兜底。类别/账号/资料授权变更使相关旧游标拒绝并要求重查。
- [ ] 目录只提供获授类别的适用信息，权限名片实时显示规则；开发支持能力说明与实际可读数据分开。错误可说明资料名称/原因，不返回受限行、正文或下载能力。
- [ ] 原件必须检查完整解析关联；A+未识别可整件下载，A/B 只有 A 则拒绝完整原件而允许 A 子集。显式多个原件目标先预检全部，再签发；不能把部分可得标为完整成功。evidence 自动引用附件走授权查询结果路径。
- [ ] 关闭公开原台账 detail/aggregate/coverage/原件及旧 flag 关闭时的绕过路径；管理员内部导入和 PDF 支持发现继续保留。经营/菜品销售保持分区接口，不增加通用行查询。
- [ ] 跑 `packages/domain/src/structured-query.test.ts`、`apps/api/src/structured-query.prisma.integration.test.ts`、`apps/api/src/routes/structured-query.test.ts`、`apps/api/src/routes/structured-partitions/routes.test.ts`、`apps/api/src/source-document-downloads.test.ts` 及两个 ledger policy 测试；验证授权发生在排序/分页前，并检查 SQL 绑定参数。自审后提交 `feat: enforce business permissions on structured reads`。

## 批次 5：evidence 搜索、引用与属性修改一致性

**范围：** `apps/api/src/evidence.ts`、`routes/evidence.ts`、`documents.ts`、`apps/worker/src/evidence-index.ts`、批次 2 管理属性接口、现有相邻测试。

**输入/产出：** 使用整份 `ResourceReadRequirement`；保留现有“候选召回 → 权威复核 → rerank”链路，把 grant/完整范围加入复核和游标规则。

- [ ] 写失败用例：B/C 共有文件即使段落只写 B，只有 B 仍不可见；旧 Qdrant payload 声称公开但 DB 收紧，rerank spy 收到的文档不得包含其正文；引用与自动来源链接同样拒绝。
- [ ] 管理员修改文件类别/范围/密级时同事务更新权威记录、版本及审计；不改内容版本、不要求重新上传。不提供片段独立定权。
- [ ] 召回过滤使用安全的当前候选条件，DB 复核作最终边界；权限放宽后也不能被旧 payload 的密级过滤永久挡住。调整索引 payload 使用方式，使授权正确性不依赖先完成全量重索引。
- [ ] 状态读取区分本人必要进度、明确 admin 管理视图和普通正文权限；旧游标要求重查，旧索引无法放行。跑 `apps/api/src/evidence.test.ts`、`apps/api/src/routes/evidence.test.ts`、`apps/worker/src/evidence-index.test.ts` 和原件链接测试，断言 provider 输入而不只断言最终响应。
- [ ] 自审 search/citation/source-link 三条通路一致，提交 `feat: apply current document business permissions to evidence`。

## 批次 6：独立 PDF 授权与照片变化修复

**范围：** `packages/ledger-archive/src/access.ts`、`source-reader.ts`、`changes.ts`、`publication.ts`、`reconciliation.ts`、`delivery.ts`、`types.ts`；API 照片/PDF 路由；worker ledger processor/reconciliation 及现有测试。

**输入/产出：** PDF requirement 仅取成品类别、唯一门店、当前类别密级及已接入维度；来源当前性校验只处理内容/业务关联/有效性，不校验调用人上游读取 grant。

- [ ] 写失败用例：仅本店 PDF 授权可得成品但不能取照片或台账原件；照片提密/撤销读取 grant 后 PDF 指纹与有效状态不变；照片撤下/替换/纠正门店后旧版不再签新链接。
- [ ] 从 `source-reader` 的内容指纹、access 的来源一致性以及 bundle entries 比较中分离权限值；保留文件校验和、内容版本、归档/关联及数据 revision 的完整性判断。不要用删除所有来源校验来实现 PDF 独立权限。
- [ ] 固定来源转换契约：本店台账、同店照片、按准确供应商匹配的模板必要字段；生成由内部身份执行。新必需维度无明确转换规则时拒绝生成，不以集团级绕过。
- [ ] 照片业务变化标记相关旧 PDF 失效，复用每日 03:00 Asia/Shanghai 巡检重做；撤下时可无照片生成，替换采用最新有效照片，生成失败不交付旧版。供应商普通内容更新继续不自动刷新历史成品。
- [ ] 跑 `packages/ledger-archive/src/access.test.ts`、`source-reader.test.ts`、`reconciliation.test.ts`、`publication.prisma.integration.test.ts`、`apps/api/src/routes/ledger-pdfs.test.ts`、`apps/worker/src/ledger-pdf/reconciliation.test.ts`；自审后提交 `feat: separate ledger PDF access from source permissions`。

## 批次 7：后台打包的三个授权边界

**范围：** `packages/db/src/partition-downloads.ts`、`packages/ledger-archive/src/delivery.ts`、`repository.ts`；`apps/worker/src/partition-download/processor.ts`、`ledger-pdf/bundle.ts`；API 两种下载路由和对应测试。

**输入/产出：** 提交时保存 manifest 版本、全部资源身份及内容引用；worker 仅消费该清单。`read`/status 不返回链接；`issueCurrent`/PDF 签发重新使用当前 `AuthorizationSnapshot`，不把拒绝读取写为任务失败。

- [ ] 写确定性生命周期测试：提交 A/B → 撤 B → worker 完成 → 本人状态 `succeeded` → 领链接拒绝且仍 `succeeded` → 恢复 B 后有效期内可领；再覆盖密级下降、扩权不追加清单和其他 admin 不能接管。沿用现有成功状态值，不另造 `completed` 枚举。
- [ ] 拆除 `checkCurrent` 等在制作/状态路径重新按发起人授权生成 manifest 的耦合；按固定资源 ID 检查内容和来源当前性。拒绝领链接只产生授权错误与审计，不调用任务 terminate。
- [ ] 保留租约、校验和、大小/超时/过期、重试、对象清理；来源归档/PDF 实际失效仍不可交付，不把缺文件的子集做成成功包。状态只验证当前有效账号、同企业、本人或明确管理能力。
- [ ] 显式完整清单全部鉴权后受理；查询导出的清单先从授权结果生成再固定。无需变更撤权通知、扫描任务或 TTL 配置。
- [ ] 跑 `packages/db/src/partition-downloads.test.ts`、`partition-downloads.prisma.integration.test.ts`、`packages/ledger-archive/src/delivery.test.ts`、`delivery.prisma.test.ts`、`apps/worker/src/partition-download/processor.test.ts`、`apps/worker/src/ledger-pdf/bundle.test.ts`；断言任务状态和持久化 manifest，不等待真实五分钟。自审后提交 `refactor: separate bundle construction from URL authorization`。

## 批次 8：准备检查、企业原子切换和安全回退

**范围：** 批次 1 权限仓储、批次 2 管理 API；新增 `apps/api/src/business-authorization-cutover.ts`、同名 `.test.ts` 和 `.prisma.integration.test.ts`；`request-auth.ts`/统一读取上下文；迁移文档及 ADR 0025 状态说明。

**输入/产出：** `prepareAuthorizationCutover(orgId)` 返回缺配置/缺属性清单及版本；`activateAuthorizationCutover(actor, expectedVersion)` 只允许当前同企业 admin 明确确认并事务启用。切换单位沿用账号组织租户边界，保留资料中的 enterpriseKey 约束，不扩大既有跨企业访问。

- [ ] 只读准备检查覆盖固定类别密级、evidence 属性、照片门店、grant、原件解析关联、目录精确名称及全部读取适配器。已有资料缺项列明，不能推断默认授权或从上传密级擅自确定类别密级。
- [ ] 用合成资料写测试：准备后类别/grant/导入改变使旧版本启用失败；未完整适配不得启用；启用事务前后的请求分别仅使用一种模型，新请求不得读到混合状态。
- [ ] 请求读取模式和权限快照一致；对签链接/发布等检查与提交窗口，用事务版本条件拒绝失效快照。普通请求不建立持续撤权监听；启用后旧客户端仍由服务端新规则鉴权。
- [ ] 新必需维度复用准备/补齐/启用流程；切换使旧游标失效。无法证明已捕获完整权限范围的旧下载任务提示重建，可证明清单的沿用批次 7，不把旧模式作为成功兜底。
- [ ] 增加安全回退运行说明：保留 schema 和新授权，回退代码不支持则暂停受影响读取；不反向迁移数据、不恢复旧授权。用本地合成用例证明暂停路径没有旧读取出口。
- [ ] 跑本批 unit/Prisma 集成及批次 1 的仓储测试，验证冲突时无部分启用；新增切换集成测试沿用 `RUN_BUSINESS_AUTHORIZATION_PRISMA_INTEGRATION=1`，加入同一隔离 runner。更新 ADR 0025 被替代条款，ADR 0026 保持存储边界。自审后提交 `feat: add atomic tenant authorization cutover`。真实企业补齐、确认和切换另行授权，本批不执行。

## 批次 9：官方 MCP、版本对齐与最终交付

**范围：** `packages/mcp-contract/src/index.ts`、`apps/api/src/mcp/{read-tools,action-tools,upload-tools,tool-handlers}.ts` 及测试；launcher runtime/用户信息/上传参数/包测试；`apps/mcp-launcher/package.json`、必要 lockfile；API/安装/使用文档；双份 `smedc-mcp` Skill。

**输入/产出：** 官方工具与批次 2 HTTP 能力一一对应，沿用现有受认证转发。新增 `get_my_permissions`、`list_account_permissions`、`get_account_permissions`、`update_account_permissions`，以及类别/维度配置、evidence 属性、准备/启用的管理工具；管理写工具采用受控 schema 和版本条件，不提供任意 API/SQL 代理。

- [ ] 写契约及 HTTP/MCP 对照测试：同账号同资料允许/拒绝一致；admin 自查/查他人完整配置；旧上传密级参数不能改变固定类别权威密级；原台账聚合和原件无旧工具旁路。
- [ ] 更新工具输入输出及 launcher 打包合同；固定类别上传使用类别配置，evidence 明确属性，照片明确唯一门店。权限不足提示可直说名称/原因，状态输出不能夹带链接。
- [ ] 实施时核对最新已发布 launcher，再选择递增版本；当前设计基线为 `0.8.2`，不在计划中占用未来版本号。运行 `npx vitest run packages/mcp-contract/src/index.test.ts apps/api/src/mcp apps/mcp-launcher/src/runtime.test.ts`，以及 `npm --workspace smedc-mcp-launcher run build`、`npm --workspace smedc-mcp-launcher run test:package`、`npm --workspace smedc-mcp-launcher run pack:check`。
- [ ] 更新 `docs/implementation/api-contract.md`、`test-cases.md`、总计划中与新模型冲突的现行说明；双份 Skill 只写 MCP 使用、安装、参数/错误及下载语义，不加入数据修复或权限决策 agent。独立仓库采用独立分支/PR，发布前不提前改 pin。
- [ ] 执行组 C 审查（同时作为批次 1–9 的最终全分支 review）：按设计第 10 节的 12 项验收逐项映射到已通过测试，同时确认全部非健康入口有服务端授权、无旧权限兜底；修复后运行下面最终门禁。不在此之前逐批另派 reviewer。
- [ ] 确认批次 1–9、约定审查和最终门禁全部完成，再推送最终实现并创建完整主仓库 PR 与必要的完整伴随 PR 供用户审阅；未完成时不得提交部分实现 PR 或合并到 `main`。描述 scope、测试、环境变化、人工输入、已知限制及分类行数。只在 durable milestone 更新 `progress.md`，不提交执行流水或 review transcript。

## 最终门禁、发布顺序与人工输入

以下是未来实现完成后的门禁，不是本轮已运行结果。各批不重复运行全库测试。

1. 在最终代码树执行一次 `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`MYSQL_PORT=3307 npm run test:integration`、`MYSQL_PORT=3307 npm run test:mcp`。现有 Prisma 文件分别需要 `RUN_STRUCTURED_QUERY_PRISMA_INTEGRATION=1`、`RUN_PARTITION_PRISMA_INTEGRATION=1`、`RUN_LEDGER_PRISMA_INTEGRATION=1`；把本计划要求的相关文件及新权限集成测试纳入现有隔离 runner，最终一次集成调用实际运行它们，不能把 skip 当成功。包测试见批次 9。
2. evidence 路径变更按总计划执行 `npm run test:phase3:golden` 和 `npm run test:phase3:perf`。需要 provider/readiness 结论时加载真实本地 `.env`；常规单元/集成允许确定性 fake provider。只跑现有有界门禁，不另加大型工作站基准或官方人工全套。
3. 测试只用合成账号/数据。数据库重置先确认 localhost/127.0.0.1；结束清除本轮 `.data/`，停止并移除本轮仓库测试容器/卷/网络，核验 Docker inventory 和 worktree，不动其他活动任务资源。
4. 全部实现完成后交付完整 PR，等待用户审阅并明确授权后才进入合并/发布步骤。执行期间不合并任何未完成实现 PR，不合并到 `main`，最终检查通过也不是自动合并授权。先获准发布并独立验证 launcher，再更新 server 推荐版本和双份 Skill pin；关联主仓库及独立 Skill PR，保持 API/launcher 兼容声明一致。
5. 获准后从 `main` 质量门禁进入 GitHub `staging` Environment 的 `npm run deploy:staging`。迁移仅增加准备能力，不自动给真实账号授权或启用企业；部署前读取运行前提与 staging readiness 文档。
6. staging 用同一小型 fixture 验证 changed workflow：权限名片/管理、一个授权查询/拒绝、原件、PDF、制作中撤权与签链；若涉及运行性能变化，同 fixture 比较。无额外授权不做真实数据回填，也不跑全套官方人工验收。
7. 企业 admin 明确补齐类别密级、evidence 属性、照片门店、账号 grant 和缺失来源关联后查看准备报告，再明确确认切换；技术回退只保留新权限或暂停读取。

后续正常人工输入在发布/企业切换边界：真实企业的类别密级和初始授权、不能机械确定的历史 evidence/照片属性、发布/部署许可与切换确认。此前未讨论的重大复杂性则在发现时立即停止并提前请用户决定，不能等到交付时才汇报。业务语义已由设计定稿，本计划不重新征询会员门店、原件未解析工作表或打包实时撤权等已确定问题。

本轮计划验收仅包括设计覆盖自审、文件路径/链接核对、Markdown 格式与差异检查；运行时测试待用户授权开始实现后执行。
