# 当前资料检索与导入管线

本文件描述当前实现的持久化和处理契约；参数、响应及权限以 [API 契约](api-contract.md)、[权限设计](business-related-authorization-design.md) 和注册表代码为准。实测结果单独保存在历史评估记录。

## 数据权威与组件边界

- MySQL 保存账号、当前授权、资料状态、审计、处理租约、保留原件关联、受控行数据及当前分区目录。
- 对象存储保存保留原件、business/dishes 当前 canonical CSV、照片、PDF 和有期限的下载包。临时来源、候选对象和过期包由有界维护任务清理。
- Qdrant 是可重建的证据检索索引。payload 过滤不能代替 MySQL 当前权限、状态及版本校验。
- API 负责校验/授权、接受任务和返回状态；worker 负责解析、索引、导入及文件制作。客户端只轮询，不启动服务内部组件。
- 服务返回受权证据/数据，调用者负责分析和答案。Skill 目录只返回元数据。

## 文档证据

支持 MD/TXT/DOCX。解析保留标题层级、段落、列表、表格和稳定来源定位，按语义/版面边界切块；当前不提供 PDF/OCR/扫描识别入口。不得把尚未合并的其他文件类型实现当成公共能力。

一个文档只有在完整解析、embedding、Qdrant 写入、版本化索引元数据及发布事务成功后才进入可检索状态。失败任务不能发布部分证据；源内容未变化时重试复用原件并幂等写入稳定 chunk ID。

检索流程为：

1. 在 MySQL 解析当前账号、组织、授权模式/版本和完整可读资料范围。
2. 使用组织、资料 ID、状态/内容/索引版本及显式筛选收窄 Qdrant 候选。
3. 合并 dense 和 lexical 候选，重新核对 MySQL 当前资料/权限，再调用允许的重排处理器。
4. 按对应检索配置做去重、重排、相关性裁剪和分页；不将不同评分尺度混排。
5. 对本页每个不同来源文档签发一次受权原件链接，返回证据与来源，绝不生成最终业务答案。

### 版本与相关性

代码支持 `phase3.retrieval.v1` 和 `phase3.retrieval.v2-bm25`，运行时由明确配置选择；可用配置不等于目标环境已完成切换。

V2 在独立 Qdrant collection 中使用 dense + 原生 BM25 sparse vectors。BM25 配置为 multilingual tokenizer、无 stemming、空 stopwords、k=1.2、b=0.75、avg_len=256，sparse vector 使用 IDF modifier；写入和查询使用同一配置。IDF 语料仅按当前组织限制，不把更窄文档筛选当作语料边界。

V2 重排后的 `relevance.v1` 默认最低分 0.30、最低分差 0.30、低分簇上限 0.40。先应用最低分，再在满足低分簇条件的分差处裁剪。缺失重排分数的候选不能使用融合分数替代，部分重排返回明确警告。响应记录 policyVersion、cutoffReason、droppedCount。

配置源：`packages/domain/src/retrieval-config.ts`、`retrieval-runtime.ts`；实现：`apps/api/src/evidence.ts`、`evidence-relevance.ts`、`apps/worker/src/evidence-index.ts`。修改模型、维度、chunker、词法配置或评分策略时创建对应版本、重建目标索引并完成评估；不能原地混入不兼容向量。

### 来源与分页

每页的 `sources[]` 按首次命中顺序去重；可用链接有效 24 小时。并发权限/状态变化或存储/签发失败时，来源返回 unavailable/null 与安全警告，不假装成功或抹去其他来源。完整返回契约见 [Evidence search response](api-contract.md#evidence-search-response)。

游标绑定当前账号、组织、授权版本、query/filters/limit 和检索配置。变化或过期要求按对应错误重新查询；游标不能充当长期访问权。

## 结构化资料

| 数据集            | 保存与读取方式                                                           |
| ----------------- | ------------------------------------------------------------------------ |
| business / dishes | OSS 当前门店日分区，授权 manifest、本地分析；不开放通用行查询/服务端聚合 |
| vip               | 受控行查询，集团级会员类别；门店字段仅供业务筛选                         |
| dish_catalog      | 以 snapshotDate 导入完整目录快照，集团级独立类别                         |
| supplier_catalog  | 受控供应商目录、集团级独立类别；作为注册的 PDF 来源                      |
| delivery_ledger   | 保留内部收货单输入和来源关联；员工只通过台账 PDF 交付路径读取成品        |

字段、别名、类型、允许查询运算和文件元数据由 `packages/domain/src/structured-registry.ts`、`structured-query.ts` 统一定义。使用 canonicalName 构造查询，sourceColumn/别名用于识别或展示，不允许任意 SQL。

CSV/XLSX 校验有文件、ZIP 条目/解压/压缩比、sheet、行、列、单元格等限制。拒绝未知或重名列、无效类型/日期和不满足数据集 schema 的输入，按注册的数据集规则处理标题、表头、汇总行和适用工作表。Excel 数据从原始单元格确定性读取；不让 agent 改写原件来绕过校验。

保留原件的数据集使用 reservation-first 异步导入：预检和原子预留 Document/ImportBatch/范围声明及 started audit，写入并验证存储后排队，worker 完成解析、校验和原子应用。相同 idempotencyKey 只用于相同字节/元数据，冲突在副作用前拒绝。202 或 queued 不表示成功；失败不能留下可见部分行。

原件读取按该文件成功解析出的全部资源要求，不以调用者当前可见子集代替全件范围。源数据普通读取先授权，再筛选、聚合、计数和分页；原始台账内部材料例外不开放。

business/dishes 的上传/发布/替换规则独立见 [当前经营分区](structured-partitions.md)。

## Worker 和发布

处理使用显式 job type、worker ownership、attempt、lease、heartbeat、有界 retry/backoff 和终态错误分类。失去租约、旧 attempt 或版本不匹配不能提交终态或发布产物。候选对象先验证，再原子切换权威指针；失败时保留仍有效的已发布数据。

上传者的普通读取权变化不取消已受理内部处理；请求状态与内容访问分别授权。后台打包按已固定清单制作，领取新链接才重验当前完整读取权。PDF 的来源变更、独立权限和计划修复见 [PDF 运维](ledger-pdf-operations.md)。

## Provider、验证与恢复

模型 provider 是显式外部处理器。真实 provider 使用须配置并确认外发边界；只发送必要 query/chunk/rerank 候选，不发送秘密、原文件全集或其他组织资料，日志不记录原始 provider 请求/响应。环境要求见 [环境变量](env-inventory.md)。

常规单元/CI 可使用确定性 fake provider；真实 provider 或 staging 就绪结论须加载实际配置并独立验证。`npm run test:phase3:golden`、`test:phase3:fixture-golden` 和 `test:phase3:perf` 是受控验证入口，详细范围见 [test-cases](test-cases.md)。

授权、过期/归档资料、错误版本和禁用账号不得泄露证据。检索评估至少报告命中/召回/排序、无答案误报、越权/陈旧命中及延迟；历史 fixture 结果见 [V2 评估](evidence-retrieval-v2-evaluation.md)，不能将一次测量当作持续 SLO。

Qdrant 可从受权原件和权威元数据重建；MySQL、当前分区和保留原件的恢复需独立备份/恢复流程。索引切换、真实回填和 remote cleanup 需遵守部署及数据授权边界。
