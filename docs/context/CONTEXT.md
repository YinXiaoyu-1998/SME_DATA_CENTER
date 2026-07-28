# 企业资料中枢

本上下文描述一个通用的企业资料中枢产品。它存在的目的不是替员工智能体做分析，而是让不同员工、不同智能体围绕同一套可信资料工作。

本文档可以使用麦家小馆作为贴近业务的示例企业，但产品定义不应绑定到麦家小馆，也不应假设只有餐饮企业才能使用。

## Language

**企业资料中枢**:
统一沉淀经营数据、历史报告、业务规则、培训材料和分析结果的资料底座，供员工智能体读取和写回资料。
_Avoid_: 经营资料中枢、AI 大脑、专用智能体系统、数据库、知识库

**员工智能体**:
由员工各自使用的通用智能体或类小龙虾工具实例，负责调用资料、执行分析、生成报告和辅助工作。
_Avoid_: 系统智能体、中心智能体

**HTTP MCP endpoint**:
企业资料中枢向员工智能体提供 MCP 工具调用的网络连接地址。它只负责传输 MCP 协议消息，员工账号识别和资料权限仍由后端强制执行。
_Avoid_: 独立智能体身份、权限绕过入口、服务运维入口

**证据检索**:
接收员工智能体给出的检索查询，并返回经过权限过滤、可追溯来源的相关资料片段和元信息。
_Avoid_: RAG 问答服务、最终答案生成、用户原始问题回答

**受控结构化查询**:
通过服务端定义的只读查询契约表达数据集、字段、过滤、排序、分页，以及调用方显式请求的纯机械分组和聚合，并返回经过权限过滤的结构化数据。
_Avoid_: 最终自然语言答案、任意 SQL、写入查询、删除行、从自然语言意图推断或自动补充分组聚合

**模型网关配置**:
用于证据检索索引构建和 rerank 的外部模型 API 配置层，通过环境变量选择 provider、base URL、模型名和密钥。
_Avoid_: 业务逻辑写死模型供应商、把模型调用用于最终答案生成

**常规报告服务**:
未来可能独立建设的定时报告或 dashboard 生成服务，与企业资料中枢隔离，通过读取企业资料中枢的数据产出常规报表。
_Avoid_: 企业资料中枢内置报告功能

**原始资料**:
从美团、沃才、点评、企业微信、Excel、截图等来源拿到的原始导出物，应尽量保持不改并记录来源和时间。
_Avoid_: 清洗后数据、分析结果

**结构化数据集**:
从原始资料清洗出来、可被查询和分析的表格化数据。
_Avoid_: 原始导出物、报告文件

**分析产物**:
员工智能体或 skill 生成的报告、图表、结论表、Excel、HTML、PPT 等结果文件，由企业资料中枢管理其位置、来源和元信息。
_Avoid_: 原始资料、经营规则

**文件对象存储**:
真实保存原始文件和分析产物文件的外部存储位置，例如 OSS。
_Avoid_: 企业资料中枢数据库

**资料目录记录**:
企业资料中枢维护的资料索引记录，用于描述文件位置、标签、上传者、状态、来源、时间和派生数据。
_Avoid_: 真实文件本体

**待处理资料**:
已进入上传流程但尚未完成必要处理的资料，不对普通员工和员工智能体可见。
_Avoid_: 活跃资料、可检索资料

**活跃资料**:
已完成必要处理并进入普通查询、搜索和智能体检索范围的资料目录记录。
_Avoid_: 待处理资料、归档资料

**处理失败资料**:
必要处理多次失败后仍未成为活跃资料的资料目录记录，只对上传者和管理员可见。
_Avoid_: 活跃资料、归档资料

**处理运行**:
一次针对资料的解析、清洗、切片、向量化或索引构建尝试，用于追踪重试和失败原因。
_Avoid_: 资料目录记录、派生索引

**派生索引**:
从文件或结构化数据中生成的辅助检索数据，例如向量表、清洗后的结构表或摘要索引。
_Avoid_: 原始文件

**权威元数据**:
企业资料中枢中用于表达账号、标签、资料目录、资料状态、对象存储位置、审计和 Skill 目录的可信数据。
_Avoid_: 派生索引、对象存储路径

**经营事件**:
会影响数据解释的事实，例如装修、闭店、促销、大排档、天气异常、平台活动、人员变动。
_Avoid_: 经营建议、分析结论

**管理知识**:
会议纪要、培训材料、老板或高管经验、标准话术、案例和 SOP。
_Avoid_: 结构化经营数据

**业务 Skill**:
封装特定业务规则、处理口径和操作步骤的可复用智能体能力包，例如 5A 菜单分析或周报生成。
_Avoid_: 经营资料、一次性脚本、中心服务功能

**Skill 目录**:
企业资料中枢管理的业务 skill 清单，用于记录有哪些 approved skill、适用场景、版本、获取方式和使用说明。
_Avoid_: Skill 执行平台、模型服务

**Skill 获取入口**:
员工智能体查询可用业务 skill、安装方式和使用示例的统一入口。
_Avoid_: Skill 托管仓库、自动升级服务

**智能体优先**:
企业资料中枢优先服务员工智能体调用，人类使用的网页或 CLI 只承担浏览、纠错、授权、删除和审计等最小管理职责。
_Avoid_: 人工网页优先、专用智能体前端

**员工账号**:
企业资料中枢中唯一的人员权限主体，员工手中的不同应用和智能体都继承同一个员工账号的资料访问权限。
_Avoid_: 每个智能体单独授权、每个应用单独账号

**登录身份**:
由当前身份验证方验证并通过稳定主体标识映射到一个员工账号的人员身份，不承载资料权限。
_Avoid_: 员工账号、邮箱地址、MCP client、launcher、access token

**登录标识**:
员工在登录页面输入、用于定位登录身份的可修改邮箱地址，不作为员工账号或资料权限的关联主键。
_Avoid_: 员工账号 ID、登录身份 ID、OIDC subject、权限主体

**身份验证方**:
负责验证登录身份和管理登录凭据与会话的模块或外部系统；beta 可使用内建实现，未来可替换为 OIDC 身份提供方。
_Avoid_: 员工账号、资料权限主体、MCP client、launcher

**密码设置链接**:
由开发者 CLI 为 beta 登录身份签发的短期单次浏览器入口，员工通过它设置只有本人知道的密码。
_Avoid_: 临时密码、永久登录链接、access token、refresh token

**离职员工账号**:
已禁用但仍保留历史记录的员工账号，不能继续访问企业资料中枢。
_Avoid_: 删除员工账号、复用员工账号

**粗颗粒度权限**:
第一阶段采用的权限模型，由员工账号和资料之间的归属标签是否命中决定能访问哪些资料。
_Avoid_: 逐字段授权、逐文件复杂授权

**归属标签**:
同时标在资料和员工账号上的平铺权限标签，表示资料或员工与某个门店、个人或其他业务范围的关系；第一阶段至少包括门店标签、个人标签和全员可见标签。
_Avoid_: 单一归属单位、文件夹路径

**门店标签**:
表示资料或员工账号属于某个门店的归属标签，一份资料可以同时带有多个门店标签。
_Avoid_: 区域标签、文件夹名

**个人标签**:
表示资料或员工账号属于某个具体员工的归属标签，用于个人私有资料或点名分享给某个员工。
_Avoid_: 上传者、作者、审计身份

**上传者**:
把资料写入企业资料中枢的员工账号，是审计字段，不等同于资料访问权限。
_Avoid_: 个人标签、资料归属

**全员可见标签**:
表示资料对所有员工账号可见的显式归属标签。
_Avoid_: 无标签即全员可见

**无标签资料**:
没有任何归属标签的异常资料，普通员工默认不可访问，需要管理员补标签后进入正常访问流程。
_Avoid_: 全员可见资料

**归档资料**:
被标记为不再活跃的资料目录记录，默认不出现在 Phase 3 evidence 检索和 structured 查询结果中，但原始文件仍保留在文件对象存储中。
_Avoid_: 永久删除、物理删除

**资料替换**:
将旧资料目录记录归档后再上传一份新资料的业务动作；企业资料中枢不把它建模为对同一资料的原地更新。
_Avoid_: 覆盖文件、原地更新资料、版本关系、替代关系

**标签清单**:
企业资料中枢中可用于权限匹配的归属标签全集，包括门店标签、个人标签和全员可见标签。
_Avoid_: 员工自由输入标签、临时标签

**标签管理员**:
少数有权限创建、删除和维护标签清单的管理员。
_Avoid_: 普通员工、员工智能体

**标签推荐**:
员工智能体根据文件名、内容或上传上下文建议资料应带哪些归属标签的辅助动作。
_Avoid_: 自动授权、自动创建标签

**权限过滤查询**:
员工账号或员工智能体查询资料时，企业资料中枢先按归属标签过滤可访问资料，再执行或返回检索结果。
_Avoid_: 先检索后提示无权限

**后端强制权限过滤**:
由企业资料中枢后端统一执行的权限过滤规则，所有 MCP、CLI、网页和 API 入口都不能绕过。
_Avoid_: 前端自行过滤、智能体自行过滤

**审计日志**:
只追加不可改写的操作记录，用于追溯上传、下载、查询、标签变更、状态变更、归档、重试和管理员操作。
_Avoid_: 可编辑日志、普通业务备注

**员工访问令牌**:
员工账号授权给 MCP、CLI 或其他工具调用企业资料中枢的访问凭据，继承员工账号权限。
_Avoid_: 独立智能体身份、应用账号

**管理员后台**:
供管理员执行纠错、授权、追溯和最小运维的辅助界面，不承担分析和报告生成职责。
_Avoid_: 普通员工知识库门户、专用智能体系统

**资料类型**:
企业资料中枢中用于分类和检索的资料大类，例如原始资料、结构化数据集、分析产物、经营事件、管理知识和 Skill 目录。
_Avoid_: 文件格式、数据库表名

**模块化单体**:
第一阶段采用的单一后端应用形态，在一个系统内划分账号权限、资料目录、上传处理、检索查询、审计、后台管理和 Skill 目录等模块。
_Avoid_: 微服务架构、大而混乱的单模块应用

**异步处理 Worker**:
与后端应用同代码库、可独立运行的后台处理进程，用于执行资料解析、清洗、切片、向量化和索引构建。
_Avoid_: 独立智能体服务、报告生成服务

**类型化处理任务**:
Phase 3 中由 ProcessingRun 表达的明确后台任务类型，例如 evidence document indexing、structured import validation/apply、index repair/delete 和后续 model reindex。
_Avoid_: 只靠 Document.status 隐式表达所有后台处理

**单企业部署**:
第一阶段只面向单个企业使用的部署和权限模型，不提供真正 SaaS 多租户隔离。
_Avoid_: 多租户 SaaS

## Relationships

- 一个 **企业资料中枢** 可被多个 **员工智能体** 访问
- **员工智能体** 从 **企业资料中枢** 读取资料，并把新文件、报告或分析结果写回 **企业资料中枢**
- **企业资料中枢** 不直接负责复杂分析、模型调用、报告生成或任务运行
- **员工智能体** 把用户意图转换为一个或多个检索查询后，调用 **证据检索** 或 **受控结构化查询**
- **企业资料中枢** 只处理收到的检索查询，不需要接收或推断用户的原始问题
- **证据检索** 返回资料片段、来源位置和检索元信息，由 **员工智能体** 组织最终答案
- **证据检索** 对 MD/TXT/DOCX 必须采用生产级混合检索底座：结构化/语义切块、embedding 向量索引、词法/关键词索引、候选合并和 rerank
- Phase 3 默认把词法/关键词索引放在 Qdrant sparse vectors / native hybrid retrieval 中，与 dense embedding 使用相同 chunk id 和 payload metadata；如评估发现词法质量不足，未来可通过检索 adapter 迁移到 OpenSearch/Meilisearch 等专用词法引擎
- MySQL 不承担 MD/TXT/DOCX chunk 级全文检索；in-process BM25 只能作为实验，不作为 Phase 3 生产基线
- 文档证据检索上线前必须有 golden evaluation suite，覆盖中文业务文档、MD/TXT/DOCX、多种查询类型、权限隐藏、归档、标签变更、禁用员工和 stale payload 场景
- 检索验收至少跟踪 hitRate@k、recall@k、precision@k、MRR@k、NDCG@k、权限泄露数、归档/stale 泄露数、no-answer false-positive 和检索/rerank 延迟；权限和状态泄露零容忍
- Phase 3 应比较 dense-only、lexical-only、hybrid、hybrid+rerank 基线；chunking、embedding、lexical、rerank、权限过滤或 payload schema 变化必须跑回归评估
- MD/TXT/DOCX 源资料只有在源文件持久化、解析、切块、embedding、Qdrant upsert、词法索引、索引版本元数据和审计全部成功后，才能成为证据检索可见的 **活跃资料**
- 向量索引或词法索引任一路失败时，资料不能进入证据检索；重试应复用未变更的源文件并创建新的 ProcessingRun，成功后再发布 active
- MD/TXT/DOCX 必须按文件类型采用结构感知切块：Markdown 按标题层级、列表、表格、代码块等结构；DOCX 按标题样式、段落、表格和页/段落位置；TXT 按段落、空行、句子边界和语义相似度
- Phase 3 证据检索只索引从 MD/TXT/DOCX 提取出的文本证据；DOCX 表格应以确定性行/单元格文本序列索引，embedded images/screenshots 不做 OCR，只记录未索引 warning
- 解析器必须记录 parser/version、parse warnings/errors、表格/图片/链接/脚注等计数和 track-changes/comments/header/footer 处理模式；malformed 文件不能 active
- 禁止把固定 `1024/512` 字符或类似固定长度切块作为主策略；固定长度只能作为极端长段落、损坏结构或无法解析结构时的 fallback，并且要在 chunk metadata 中标记
- 每个文档 chunk 必须记录 `document_id`、`chunk_id`、`source_type`、heading/path 信息、页码或段落/位置标识、字符范围或等价定位信息，以便员工智能体能追溯来源
- 向量索引中必须保存可返回的文本片段、embedding、来源资料 id、片段位置、模型版本、权限过滤所需 metadata 和其他检索元信息，不能只保存 embedding 数组
- 文档证据检索 API 只返回 evidence，不返回 answer；每条结果至少包含 chunk 文本、`document_id`、`chunk_id`、相关性分数、来源标题/文件类型/heading path/页码或位置、匹配路径、embedding 模型、rerank 模型和 rerank 状态
- 文档证据检索响应必须能表达 `matched_by`（例如 dense、lexical、rerank）和 `rerank_status`（例如 enabled、disabled、rerank_disabled），便于调用方智能体理解结果质量
- Phase 3 必须把源文档权威状态和检索索引状态分开建模：`Document` 保存源文件、权限、状态、`contentVersion` 和 `labelVisibilityVersion`；`DocumentIndex` 保存某内容版本在某 retrieval config 下的索引 ready/failed/deprecated 状态；chunk manifest 用于审计、repair 和返回前校验
- Qdrant point id / `chunkId` 必须由 `{documentId, contentVersion, retrievalConfigVersion, chunkOrdinal}` 或其稳定 hash 派生；内容替换或 retrieval config 变化后必须生成新 chunk id，避免旧/新证据混淆
- Qdrant payload 可保存 chunk text/snippet、版本、来源位置和诊断 snapshot，但这些 snapshot 不能作为权限真相；label 名称、员工信息和敏感权限细节不应进入 Qdrant payload
- 归档、标签变化和内容替换的生效点都以 MySQL 权威状态为准；Qdrant cleanup/payload repair 可以异步，因为返回前 revalidation 会丢弃 stale hit
- Phase 3 baseline 内容替换采用严格语义：替换期间资料不可检索，直到新 `contentVersion` 的完整索引 ready 后再发布 active；无中断双版本替换属于 P2
- embedding 和 rerank 可以使用外部模型 API，但必须通过 **模型网关配置** 显式启用，不能把供应商或模型名写死进业务逻辑
- 新 Phase 3 模型配置使用 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_EMBEDDING_MODEL`、`OPENAI_COMPATIBLE_API_KEY`、`OPENAI_COMPATIBLE_BASE_URL`；密钥只从运行环境读取，不进入代码、文档示例值或审计输出
- 这组 `LLM_*` / `OPENAI_COMPATIBLE_*` env 在 Phase 3 中只用于 embedding/rerank 检索基础设施，不代表企业资料中枢可以生成最终答案；baseline 必须继续支持这些变量，后续可增加更明确的 `EMBEDDING_*` / `RERANK_*` 别名但不强制改名
- env/secrets 负责连接信息、密钥和部署级限流；retrieval config、field registry、模型/索引/chunker 版本属于 DB 或代码种子里的 versioned config，不能只散落在 `.env`
- real external embedding/rerank provider 启用时必须有数据出境确认 gate，例如 `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true`；fake provider 的 local/CI 可不启用
- Phase 3 env inventory 必须新增 Qdrant 连接、collection、timeout，storage/OSS/local storage，worker concurrency/lease/retry，structured query/import limits，并标记 secret、适用环境和缺失时失败行为
- 每个向量 chunk 必须记录 embedding 模型名、维度、模型版本/配置版本；rerank 调用也应记录模型名和版本，便于质量评估和未来重建索引
- embedding 模型用于把文本转成向量以便召回；rerank 模型用于对已召回候选做更精细排序。两者可以来自同一供应商，但不是同一种模型职责
- 新 Phase 3 必须真实接入 rerank provider：实现 rerank 接口、真实 OpenAI-compatible provider 路径、fake rerank 测试路径、结果排序路径和可观测记录；调试效果可后置，但 adapter/provider/config/调用链/status recording 是 baseline，未 rerank 时必须明确记录并返回 `rerank_disabled`
- embedding/rerank 仍通过 env/secret 配置保持实现简洁，但运行时必须把 env 解析为明确的 retrieval config 版本；配置变化必须通过并行索引重建、golden evaluation、显式 promote 和可回滚 retention 处理，不能通过静默改 `.env` 让新 query embedding 去查旧向量
- embedding 维度变化时必须使用新的 Qdrant collection 或等价隔离索引；调用方不能任意选择模型，只有内部评估路径可受控 override
- 外部模型调用必须有候选数上限、timeout、批处理、迁移限速、成本/延迟/错误率监控和明确 fallback 语义
- embedding/rerank provider 是显式外部数据处理器；启用前必须由管理员配置并确认数据出境，系统不能在未确认情况下把文档 chunk、query 或候选 chunk 发给外部 provider
- 外部模型请求必须最小化 payload：embedding 只发送必要 chunk/query text，rerank 只发送 query 和已授权候选 chunk；默认日志、审计、错误和 trace 不得记录原文或 provider request/response body
- 系统不得把同一次外部模型请求混入多个 org 的内容；provider fallback 必须显式配置，不能静默改发另一个 provider
- **权威元数据** 和资料状态仍由事务型数据库维护；向量库命中后必须回到来源资料校验活跃状态和当前员工账号权限
- Qdrant payload filter 只能作为检索空间缩小优化，不能作为授权真相源；文档证据检索返回前必须回 MySQL 复核员工状态、资料 active 状态、标签权限、content/visibility version 和索引版本
- 资料归档、标签变化、员工禁用或内容替换必须通过 MySQL 立即影响检索可见性；Qdrant 删除、payload 更新或重建索引可以异步执行，因为 stale hit 会在返回前被 MySQL 复核丢弃
- MySQL 主要承担权威业务元数据、权限元数据、上传/处理状态、审计日志，以及 CSV/XLSX 解析后的结构化菜品/营业行数据
- 向量数据库承担 MD/TXT/DOCX 非结构化文档的检索索引，保存 chunk text、embedding 和 chunk metadata；MySQL 不作为纯文本 RAG 检索底座
- 向量数据库不作为菜品/营业表格数据的权威查询存储；CSV/XLSX 的业务查询由 MySQL 结构化表完成
- MySQL 与向量数据库通过 `orgId`、`documentId`、chunk/source metadata 等 id 关联，用于权限、状态、审计和追溯校验
- 新 Phase 3 默认向量数据库为 Qdrant，用于 MD/TXT/DOCX 非结构化文档 chunk 检索索引；Milvus 保留为未来数亿/十亿级向量、GPU 检索或重型集群吞吐场景的再评估选项
- pgvector 不作为当前默认方案，因为现有权威数据库是 MySQL，引入 PostgreSQL 只承担向量检索会增加额外数据库栈；如未来权威数据库迁移到 PostgreSQL，可重新评估
- 新 Phase 3 只支持五种上传文件类型：Markdown、TXT、DOCX、XLSX、CSV；JSON 暂不支持，已有 JSON 文本处理残留应在实施时删除
- Phase 3 底层统一使用 `Document`、OSS、audit、worker 和 `ProcessingRun`，但 HTTP 表面应区分 evidence document upload 与 structured import，避免一个泛化 upload endpoint 接受过多 mode 参数
- evidence upload 支持 MD/TXT/DOCX，创建 `Document(documentKind=evidence)`、`ProcessingRun(evidence_document_index)` 和 `DocumentIndex`；structured import 支持 XLSX/CSV，创建 `Document(documentKind=structured)`、`ImportBatch` 和结构化处理任务
- `Document.status` 只表达源文件整体状态；evidence 检索还必须检查 `DocumentIndex.status=ready`，结构化查询还必须检查 `ImportBatch.status=applied`
- unsupported file type 和 JSON 上传必须返回稳定错误，例如 `415 UNSUPPORTED_FILE_TYPE`；XLSX 上传到 evidence endpoint 或 DOCX 上传到 structured endpoint 也必须失败
- OCR、PDF、图片理解、跨 dataset join、任意公式/窗口函数、自然语言生成结构化查询、服务端分析/报告/dashboard、独立行级权限、自动覆盖/追加/替换导入和 JSON ingestion 都不属于新 Phase 3 baseline；其中多数应作为 P3
- **受控结构化查询** 只允许服务端白名单中的数据集、字段、过滤运算符、排序、分页，以及调用方显式请求的分组和聚合能力
- **受控结构化查询** 不接受 SQL 字符串，也不提供新增、修改、删除或数据库定义操作
- **受控结构化查询** 不从自然语言意图里推断聚合；没有 `metrics` / `group_by` 时返回匹配记录，由 **员工智能体** 决定是否再聚合、分析或组织最终答案
- **企业资料中枢** 必须清楚发布每个结构化数据集、API 和字段的定义，例如 `order_time` 表示下单时间，`business_date` 表示营业日
- **企业资料中枢** 不根据用户自然语言意图判断应使用哪个字段；例如“7 月 5 号”应映射到 `order_time` 还是 `business_date`，由调用方 **员工智能体** 在生成结构化查询时决定
- 结构化查询 API 扮演数据提供层角色，只接收调用方已经整理好的受控 query；它不知道上游用户原始问题，也不输出业务解释、趋势判断、经营建议或自然语言结论
- 结构化查询响应应返回 `rows`、`columns`、受控 `query` 回显、pagination/row_count/truncated 等 metadata，以及 source/import batch/document id；显式聚合请求只返回机械聚合结果
- 结构化查询必须支持分页和单次返回上限；默认 `limit` 和最大 `limit` 由 API 契约定义，超过单次上限时返回 `next_cursor` / `truncated` 等 metadata，调用方智能体通过分页获取完整数据
- 结构化查询不能提供绕过分页的一次性全量导出能力，除非未来单独设计受控批量导出接口
- 结构化明细查询默认按稳定行血缘排序，例如 import batch、sheet index、source row number 和 row id；聚合查询默认按 group key 排序，分页对象是 group rows 而不是原始 rows
- 结构化查询 cursor 是绑定调用方、权限 scope、dataset、registry version、query shape、filter、sort、limit、位置、查询模式和 active import scope 的 opaque token；权限或 active scope 变化时 cursor 可失效
- Phase 3 不承诺多页查询的长事务 snapshot consistency；每一页必须重新授权并只返回当前可见数据
- baseline 查询复杂度限制建议：默认 50 行、明细最大 200 行、聚合 group 最大 100、boolean depth 3、条件总数 20、`in` 值 100、sort 2、groupBy 1、aggregate 5、select 50
- 无索引/高成本 filter、未 allowlist 的 `contains`、高基数字段 groupBy 和超限条件必须在 SQL 执行前拒绝，而不是尝试运行后超时
- 结构化查询对外暴露正常可读的 JSON API 请求结构，可参考常见 Java MySQL query wrapper / specification 风格表达字段、条件、排序、分页和显式聚合；语义上覆盖常见 MySQL 查询，但不是 SQL 字符串或任意表达式
- 结构化 API 错误必须是稳定、机器可读的 envelope，包含 error code、safe message、retryable、details 和 requestId；调用方智能体不应解析自然语言错误来恢复
- 结构化查询可带 registryVersion；成功响应返回 effective registryVersion。registry 不兼容、字段/能力不支持、limit 超出、幂等冲突、active import 冲突、临时故障等必须有稳定错误码
- 权限隐藏的数据应被 scope out；没有可见行时返回成功空结果，不能通过错误、count、pagination 或 aggregate 泄露隐藏数据
- Phase 3 HTTP API 是唯一权威后端契约；MCP 只是这些 HTTP endpoint 的薄适配，不能成为第二套权限、查询校验、导入或检索实现。ADR 0018 记录该边界
- Phase 3 baseline HTTP API surface 包括 evidence search、structured import create/status、structured dataset discovery、controlled structured query；worker/admin/operator/provider/schema 控制保持 HTTP/admin-only 或内部运维入口
- Phase 3 API baseline 使用 opaque cursor 分页；cursor 需要绑定调用方、org、query shape、registry version 和 sort，不能暴露 DB offset 或 Qdrant internals
- 结构化查询内部可以把受控字段/operator 编译为参数化 SQL；外部调用方不能拼接 SQL、`WHERE` 子句、`LIKE` 片段、正则表达式或任意函数
- 结构化查询 operator 是服务端 allowlist 能力，例如 `eq`、`neq`、`in`、`not_in`、`gt`、`gte`、`lt`、`lte`、`between`、`contains`、`starts_with`、`ends_with`、`is_null`、`is_not_null`；每个字段必须声明允许的 operator、类型、nullable 和取值限制
- 结构化查询应支持受控 `and` / `or` 条件树，但必须限制最大嵌套深度、最大条件数、最大 `in` 列表长度和其他复杂度指标；具体阈值在 API contract / 实施阶段确定
- 显式机械聚合必须逐字段声明能力：`groupBy`、`aggregateInput`、允许函数、单位/scale、基数限制和索引要求；完整字段覆盖不代表所有字段都能分组或聚合
- Phase 3 聚合函数限定为机械函数，例如 `count`、`countDistinct`、`sum`、`avg`、`min`、`max`；不支持窗口函数、任意公式、跨 dataset join、增长率/占比/趋势等派生业务指标或自然语言分析
- 聚合前必须先应用后端权限过滤；触及敏感字段的聚合查询需要审计
- **证据检索** 可以为提高文档召回率而改写检索文本或扩展文档检索查询，但这种处理不能生成面向用户的最终自然语言答案
- 新 Phase 3 不包含结构化数据的实体/菜品名扩展；例如把“肉夹馍”扩展到“青椒肉夹馍”“优质肉夹馍”应作为后续独立功能设计
- **常规报告服务** 如未来出现，应作为独立服务读取 **企业资料中枢**，而不是成为 **企业资料中枢** 的内置职责
- **企业资料中枢** 管理 **原始资料**、**结构化数据集**、**分析产物**、**经营事件** 和 **管理知识** 的沉淀与访问
- Phase 3 的重处理必须使用类型化 ProcessingRun、DB lease、幂等 job key、retry/backoff 和 explicit publish gate；不能只靠 `Document.status` 隐式推进
- baseline 任务包括 evidence document indexing、structured import validation、structured import apply、index repair/delete；model reindex 编排属于 P2，除非模型迁移测试需要
- Phase 3 baseline 运维必须覆盖 MySQL、Qdrant、OSS、worker 和外部模型 provider 的 readiness checks、核心指标和告警；operator dashboard、自动修复、成本预算、adaptive concurrency 等进入 P2
- Qdrant 是 Phase 3 baseline 依赖，不是可选实验组件；local compose / MVP bootup 需要真实 Qdrant，CI 可以分层但 merge-gating 集成测试必须覆盖真实 Qdrant，staging/prod-like 必须把 Qdrant 纳入 readiness gate
- Qdrant OSS 上游仓库标注 Apache-2.0 license；baseline 自托管路径的成本主要是主机、磁盘、备份、监控、安全、升级、故障处理和容量规划，而不是 Qdrant Cloud 订阅作为运行许可
- 中国大陆/阿里云部署默认自托管 Qdrant，不能假设 Qdrant Cloud 有中国大陆阿里云托管区域；Qdrant Cloud/Hybrid/Private Cloud 只有在完成商务、区域、网络和数据驻留确认后才可替代
- staging/prod-like 应把 Qdrant 镜像 pin 到确定版本，并同步到 approved Alibaba Cloud ACR 或内部制品仓库，避免依赖部署时实时拉取公网镜像
- 本地和 CI 可默认使用 deterministic fake embedding/rerank provider，以避免真实 API key、费用和数据外发；真实外部 provider smoke 应使用合成文本并作为 manual/nightly/staging preflight
- Qdrant 索引可从 MySQL、OSS 源文件和 retrieval config 重建，但 staging/prod-like runbook 仍需定义 snapshot 或 rebuild 策略；自动 snapshot/restore drill 和一键 rebuild 属于 P2
- Phase 3 MCP 仍然只是 HTTP API 的薄适配，不直连 MySQL/Qdrant/OSS/model provider，不重复权限/查询校验，不暴露 worker/admin/operator 控制
- 员工智能体可通过 MCP 做 evidence search、structured dataset discovery、controlled structured query、structured upload、evidence document upload 和 import/status；模型配置、强制重建索引、worker retry、schema registry 编辑、导入声明修复等保持 HTTP/admin-only
- 在真正修改 `implementation-plan.md` 前，必须做 phase renumbering impact audit；旧 `Phase 3` / `phase-3` 引用需要分类为新检索 Phase 3、旧 staging/readiness 阶段、历史引用或 stale reference
- supporting docs 优先使用语义化命名；`phase-3-readiness.md` 已按用户确认重命名为 `staging-readiness.md`
- 历史 progress、handoff、accepted ADR context 不应逐条重写；应通过追加 note 说明 phase numbering changed
- 原始文件和报告文件保存在 **文件对象存储** 中，**企业资料中枢** 主要维护 **资料目录记录**、**权威元数据** 和 **派生索引**
- **权威元数据** 应保存在事务型数据库中，作为权限判断、资料状态和审计追溯的来源
- **文件对象存储** 的路径不表达业务权限，资料访问必须通过 **资料目录记录** 和 **后端强制权限过滤** 判断
- 菜品数据和营业数据导入 **结构化数据集** 时必须采用整份文件原子语义：结构校验、字段类型校验、必填字段校验和行级校验全部通过后，才能写入可查询 MySQL 表
- 菜品数据和营业数据中任一必需校验失败时，整份上传资料保持为 **处理失败资料** 或等待人工处理，不能部分写入权威查询表；错误摘要应指出失败字段、行号和原因
- 结构化导入失败响应应返回可操作但不泄露内部实现的错误结构，例如 `error_code`、`summary`、`failed_stage`、`sheet_name`、`row_number`、`field`、`reason` 和有限数量的错误样例；完整内部堆栈只进入服务日志，不进入 API 响应
- 表格校验规则必须基于真实导出样本定义字段可空性和类型宽容度；真实数据中允许为空的字段不能被简单地当作必填错误
- 菜品和营业 MySQL 表 schema 以及结构化 API 字段注册表必须完整覆盖当前真实导出的列集合；不能只挑选 demo 字段，否则员工智能体会遇到文件中存在但结构化 API 不可发现或不可请求的数据
- 完整覆盖不等于每个字段支持所有查询能力；每个结构化字段必须定义 canonical name、原始表头 alias、类型、nullable、敏感度、兼容状态、是否默认返回、是否可显式选择、允许 operator、是否可排序、是否可聚合/分组、索引状态和取值限制
- 真实 dishes/business XLSX 样本用于 profiling 和生成字段注册表初稿，但不能让运行时自动猜 schema；生产契约必须经过人工 review 后固化为 MySQL migration + versioned field registry
- profiling 必须输出 source column、稳定 public field name、受控 header aliases、候选类型、null/blank 规则、cardinality、金额/百分比/日期语义、默认返回、字段能力和异常样例
- 当前真实导出所有列必须进入 MySQL schema 和 field registry；未知新增列、缺失 required 列、模糊改名列在 baseline 都导致整份 workbook fail，直到人工 review 后发布新 registry version
- 金额字段使用 decimal，百分比字段必须明确 ratio/percentage-points 语义，业务编码/编号优先按 string 处理，不能仅因样本值像数字就开放数值聚合
- 所有字段默认可被 schema discovery 发现，安全允许时可显式 select；filter/sort/group/aggregate/contains 等能力必须按字段 profile、cardinality 和业务语义逐项 allowlist
- 结构化 API 必须采用完整但能力受控的字段注册表；高基数、自由文本、敏感或不稳定字段可以被发现和显式选择，但过滤、排序、聚合、分组和 `contains` 等能力必须逐字段 allowlist
- Phase 3 必须提供结构化 schema discovery API，例如 `GET /structured/datasets`，让员工智能体读取 dataset、字段、版本、限制、capabilities、operators、敏感度、生命周期和索引状态后再构造受控查询
- 员工智能体不能因为字段存在就假设它可过滤、排序、分组或聚合；必须遵守 schema discovery 中的字段能力和 dataset 级复杂度限制
- 用户上传的文件名只作为原始元数据保存，不参与表格类型识别、企业归属、日期范围或任何业务逻辑判断
- 系统内部导入批次名必须使用规范化名称：菜品数据采用 `{enterprise_name}_dishes_{start_date}_{end_date}`，营业数据采用 `{enterprise_name}_business_{start_date}_{end_date}`；`start_date` 和 `end_date` 使用 `YYYYMMDD`
- 校验通过后，OSS 中保存的结构化源文件副本使用导入批次规范名保存，例如 `{enterprise_name}_dishes_{start_date}_{end_date}`；不按营业日拆分为多个文件
- 表格中的每一行写入对应 dataset 的 MySQL 查询表；按天检索和筛选通过 MySQL 的 `business_date` 等字段完成
- Phase 3 应引入 `ImportBatch` 或等价 MySQL 模型表达一次结构化导入尝试/结果；`Document` 仍是源文件和权限/OSS 锚点，`ImportBatch` 是结构化行数据、校验、幂等、日期窗口和审计边界
- `DishRow` / `BusinessRow` 必须关联到唯一 `ImportBatch`，并保留 `documentId` 方便追溯；结构化 `ProcessingRun` 和审计日志应同时关联 `Document` 与 `ImportBatch`
- 结构化行查询必须继承源 `Document` 的标签权限；`orgId` 和 dataset 不是充分授权条件。后端必须先限定调用方可见的 source document/import batch，再执行过滤、聚合、排序和分页
- 隐藏的结构化批次不能通过 count、sum、group、分页数量或错误信息泄露；不同可见性批次同时存在时，查询只返回调用方可见批次的行
- 结构化导入的企业级主键必须沿用现有组织上下文 `orgId` / `Organization.id`，由 authenticated employee 的服务端权限上下文决定；调用方不能通过 metadata 任意指定或覆盖业务主键
- `enterprise_name`、`dataset`、`start_date` 和 `end_date` 必须由上传接口的 metadata 显式提供，不能从上传文件名推断；`enterprise_name` 是展示和规范文件名组件，不是权限、去重或查询主键
- `dataset` 只允许 `dishes` 或 `business`；内容 schema 必须与 metadata 声明的 dataset 一致，否则整份文件失败
- 规范名里的 `start_date` 和 `end_date` 表示营业日范围，对应结构化字段 `business_date`，不是下单时间 `order_time` 的日期范围
- 表内所有 `business_date` 必须完全落在 metadata 声明的 `start_date` / `end_date` 闭区间内，且表内最小/最大营业日必须分别等于 metadata 的 `start_date` / `end_date`
- metadata 营业日范围与表内营业日范围不一致时，整份文件校验失败；系统不根据表内数据猜测或修正调用方提供的 metadata
- 表格类型必须由内容结构和严格 schema 校验识别为菜品数据或营业数据，不能只靠文件名中的 `dishes` / `business`
- CSV/XLSX 表头列顺序可以不同，但每个表头必须通过受控 alias 映射到唯一 canonical 字段，例如 `营业日` 映射到 MySQL 字段 `business_date`
- 表头 alias 只用于已配置的列名到 canonical 字段映射，不用于语义猜测、实体扩展或用户意图判断
- CSV/XLSX 校验器不能固定假设第 3 行是表头；必须扫描前 10 行，找到唯一一行满足对应 schema 的表头
- 必需字段缺失、重复映射到同一 canonical 字段、未知额外列、表头无法映射或字段类型校验失败时，整份文件失败
- 扫描前 10 行找不到合法表头，或找到多个合法表头候选时，整份文件失败
- XLSX 可以包含多个数据 sheet；参与导入的每个 sheet 都必须满足同一个 dataset schema、同一套字段校验和同一个 metadata 营业日范围
- 同一个 XLSX 上传不能混合菜品数据和营业数据 schema；任一数据 sheet 不满足对应 schema 或出现混合 schema 时，整份文件失败
- XLSX 中完全空的 sheet 可以忽略并记录；任何非空 sheet，包括说明 sheet 或隐藏 sheet，都必须能识别为同一 dataset schema 并匹配同一 metadata 营业日范围，否则整份文件失败；匹配的隐藏非空 sheet 参与导入，不能静默跳过
- 多 sheet 导入必须记录 sheet 级血缘：导入/忽略 sheet 名称与数量、每个 sheet 行数；每行必须记录 `sourceSheetName`、`sourceSheetIndex`、`sourceSheetHidden`、`sourceRowNumber` 和 `sourceRowHash`
- 结构化导入验收必须覆盖真实 67k 行菜品 workbook、151 列营业 workbook、小型 CSV/XLSX、invalid/adversarial variants、完整字段 registry、nullable/type profiling、原子失败、幂等、并发、权限继承和性能指标
- 同一 `{orgId, dataset, start_date, end_date}` 已存在 active 导入时，新上传不能自动覆盖或追加；应直接失败，并提示需要先归档/撤销旧导入或使用未来明确设计的替换导入能力
- 重复导入判断必须以 `orgId` 为企业级主键，并保留 `enterprise_name` 作为人类可读名称和规范文件名来源；不能只依赖可变的企业展示名
- 新上传命中已有 active/applied `{orgId, dataset, start_date, end_date}` 时必须返回冲突错误，即使源文件完全相同；同一 idempotency key 与同一 request fingerprint 的重试才返回已有批次状态
- 结构化源 `Document` 归档后，对应 rows 可以保留在 MySQL 里用于审计和故障排查，但必须立即不参与明细查询、count、sum/avg、groupBy 或 pagination
- 结构化查询资格必须同时满足 `ImportBatch.status = applied`、source `Document.status = active`、当前员工有 source Document 标签权限且员工账号有效
- 如果 active 导入窗口的数据错误，Phase 3 baseline 恢复路径是显式 archive old source document/import batch，再重新上传同窗口新文件；不提供一步替换、覆盖或 append
- failed/rejected 导入不应永久占用 active window；in-progress 同窗口返回 `IMPORT_IN_PROGRESS`，由 worker lease/retry 恢复或失败原 batch
- hard delete/purge 不属于 Phase 3 baseline；生产 purge 需要未来 admin-only 设计、保留策略、审计 tombstone、OSS 删除、备份影响和安全审查
- Phase 3 应使用 `ImportWindowClaim` 或等价事务性声明机制防止同一结构化日期窗口并发导入和重复 active 批次
- 结构化上传只有在源文件保存到 OSS、schema 校验通过、metadata 与内容一致性校验通过、所有行以事务或等价原子流程写入 MySQL、导入批次记录/资料目录记录/审计日志写入成功后，才能成为 **活跃资料** 并进入结构化查询
- 结构化上传任一 active 门禁失败时必须保持为 **处理失败资料** 或待人工处理状态，不能出现在普通结构化查询结果中
- **业务 Skill** 可包含经营规则、分析口径和处理流程；**企业资料中枢** 可以通过 **Skill 目录** 管理和分发 skill 信息，但不执行 skill
- **Skill 目录** 通过 **Skill 获取入口** 向 **员工智能体** 提供可用 skill、推荐版本、安装方式和使用范例
- **企业资料中枢** 不托管 skill 执行环境，不负责自动升级员工本地的 skill
- **企业资料中枢** 采用 **智能体优先** 的使用方式，人类后台和 CLI 是辅助入口
- **员工智能体** 访问 **企业资料中枢** 时继承其所属 **员工账号** 的权限
- **员工账号** 是第一阶段唯一的权限主体，不为每个智能体或应用单独建权限身份
- 一个 **登录身份** 必须且只能显式绑定到一个 **员工账号**；数据模型允许一个员工账号绑定多个登录身份，但 beta 只实现一个启用的本地密码身份，且不提供添加、切换或自助关联多个身份的入口
- **登录身份** 必须通过显式稳定关联绑定到员工账号；**登录标识** 只用于定位登录身份，不能用于自动创建或自动绑定员工账号
- 邮箱 **登录标识** 在整个部署中全局唯一；规范化只去除首尾空格并进行不区分大小写的完整地址比较，不删除点号或 `+suffix` 等邮箱服务商特有语义
- **身份验证方** 验证登录身份；**企业资料中枢** 根据映射后的员工账号执行后端强制权限过滤
- 本地密码登录允许连续失败五次，此后按 5、10、20、40、60 分钟等待并以 60 分钟为上限；冷却期间的请求不增加计数或延长时间，成功登录或完成开发者发起的密码重置会清零
- 禁用 **员工账号** 必须使已有登录会话无法继续访问资料，即使身份验证方签发的 token 尚未自然过期
- beta 新员工入驻由一个开发者 CLI 操作在同一事务中创建 **员工账号**、对应的 **个人标签** 和唯一启用的本地密码 **登录身份**，成功后再签发 **密码设置链接**
- 开发者 CLI 可以为 beta **登录身份** 签发 **密码设置链接**；员工只在浏览器页面设置密码
- launcher 作为无客户端密钥的桌面 public client，通过系统浏览器、Authorization Code、PKCE、`state` 和 `127.0.0.1` 随机端口回调完成登录；回调只携带单次授权码，launcher 再通过 HTTPS 换取凭证
- beta 登录、密码设置和安全错误页面由现有 API 在当前 HTTPS 域名上直接返回服务端 HTML，不新增前端框架、独立容器、域名或 `apps/admin-web` 实现
- 浏览器只保存最长 10 分钟的授权事务 Cookie，不保存长期登录状态；授权码交给 launcher 后，关闭页面或清空 Cookie 不影响 launcher 的持续 MCP 访问
- Enterprise Hub token 接口签发有效期 10 分钟的 bearer access token，launcher 只在进程内存中持有并使用长期会话凭证自动续取；launcher 重启也不需要重新打开浏览器
- access token 是至少 256 位随机强度的不透明 bearer 字符串，MySQL 只保存其哈希和会话、员工账号、过期、撤销元数据；每个受保护请求必须查询服务端权威状态
- launcher 长期会话从最近一次浏览器密码登录起绝对有效 30 天，不设置额外闲置超时，也不能通过日常使用或 access token 续取延长
- launcher 长期凭证在每次 access token 续取时轮换；服务端只保存各代哈希和会话家族关系，任何已消费旧凭证重放都会撤销整个家族并要求重新进行浏览器登录
- launcher 只把长期凭证存入 macOS Keychain 或 Windows Credential Manager；安全存储不可用或写入失败时停止认证，绝不降级写入普通文件、配置、日志或剪贴板
- 同一操作系统用户在同一个 Enterprise Hub 服务地址下只有一个当前账号，Codex 和其他本地 Agent 共享同一安全存储记录；beta 不提供账号列表、切换或多账号并存，凭证续取通过跨进程 single-flight 锁串行化
- official launcher 使用固定、非秘密的 public client ID，通过固定 Authorization Code + PKCE 端点和服务端 metadata 工作；不支持动态客户端注册、password grant、客户端密钥、任意 scope 或 audience
- launcher 权威源码保留在 private 主仓库 `apps/mcp-launcher`，通过 GitHub Actions 的 npm Trusted Publisher/OIDC 发布公开版本包；Trusted Publisher 可用于 private GitHub repo，但 npm provenance 对 private source repo 不可用，因此发布流程不得声明或要求 provenance；正式 cutover 的 skill 固定 `enterprise-hub-mcp-launcher@0.1.0`，只锁定并安装发行版本，不复制 launcher 源码，暂不建立独立 launcher 仓库
- Enterprise Hub skill 是安装编排说明的唯一入口：用户只需向已有该 skill 的 agent 提出自然语言安装请求，agent 按说明为当前用户安装依赖和 launcher、备份并更新自己的 MCP 配置、执行自检，再由 launcher 打开浏览器登录
- Codex 和 OpenClaw 的 macOS/Windows 安装与使用链路是首批明确支持并验收的客户端矩阵；对 Qoder 等未命名 agent，skill 仍应提供受约束的自适应说明，允许 agent 判断自己的 MCP 配置位置和方式，在备份、最小修改、不影响其他 MCP 服务并验证成功的前提下完成安装
- launcher 不自行升级；服务端只公布最低支持版本和推荐版本，由主仓库与独立仓库中保持同步的 Enterprise Hub skills 决定何时升级、选择哪个已批准的精确 npm 包版本，并指导 agent 完成安装和自检
- “退出登录”撤销并删除当前操作系统用户共享的长期会话；从单个 agent 移除只删除该 agent 的 MCP 条目；“彻底卸载”才清理所有可安全发现的本地集成、launcher、本地状态和系统凭证，且三者都不删除员工账号、业务资料或 Node.js/npm
- 每个操作系统用户和 canonical Enterprise Hub HTTPS origin 只有一条版本化系统安全存储记录，其中只包含长期凭证和最小格式信息；轮换后新凭证写入或验证失败时必须尝试撤销并重新浏览器登录，绝不写普通文件或继续使用旧值
- launcher 对登录失效、服务不可用、权限不足和版本过旧返回不同的机器可读状态；skill 指导 agent 恢复，浏览器登录成功后 agent 自动重试原操作一次，取消或超时不得循环弹窗
- beta 不实现会话列表、单会话撤销 CLI 或设备管理页面；电脑丢失时由开发者签发密码重置链接，用户成功设置新密码后撤销该登录身份全部旧会话
- beta 保留 90 天最小身份安全审计，记录账号/密码设置、登录结果、冷却、会话生命周期、重放和安全拒绝等事件；不得记录任何密码、hash、token、授权码、PKCE、设置密钥或完整请求，且不做审计页面和实时告警
- beta 不增加来源 IP/端点级身份限流、验证码或外部反机器人服务；只保留已确定的单登录身份五次失败后递进冷却，额外设施在用户规模或实际攻击迹象变化后再评估
- beta 密码长度为 8–128 个 Unicode 字符，允许空格/粘贴/密码管理器，不设大小写数字符号组合或定期修改规则；使用小型本地常见密码列表拦截明显弱值，并只保存经过实机基准测试的 Argon2id 加盐 hash
- 现有 development email/JWT 认证系统完全删除，不保留任何环境或测试兼容路径；所有环境、自动化测试、runtime env、部署脚本、文档和两份 skills 一次性切换到正式身份、授权码 + PKCE、不透明 access token 与轮换长期会话
- **员工账号** 通过 **粗颗粒度权限** 访问资料，第一阶段只由 **归属标签** 命中关系决定
- 每个 **员工账号** 必须有且只有一个对应的 **个人标签**
- **离职员工账号** 应被禁用但不删除，其对应的 **个人标签** 保留在标签清单和历史资料上
- **资料类型** 是分类和检索维度，不参与第一阶段权限判断
- **员工账号** 和资料都可以拥有多个 **归属标签**
- 当资料的任一 **归属标签** 与员工账号的任一 **归属标签** 匹配时，员工账号可访问该资料
- 带有 **全员可见标签** 的资料对所有员工账号可见
- **个人标签** 可用于把资料点名分享给某个员工，即使该员工没有资料上的其他业务标签
- **门店标签** 是第一阶段需要支持的归属标签类型，用于门店资料和门店员工之间的访问匹配
- 第一阶段不需要区域标签，也不存在标签继承或自动展开
- 资料上传时自动记录 **上传者**，并默认添加上传者自己的 **个人标签**
- **上传者** 用于审计追溯，**个人标签** 用于权限匹配，二者不能混为一谈
- 正常资料不应成为 **无标签资料**；上传时自动添加上传者个人标签，异常无标签资料只能由管理员补标签
- **标签清单** 只能由 **标签管理员** 创建、删除和维护
- 普通员工和 **员工智能体** 只能选择已有标签，不能自由创建新的归属标签
- 新员工加入时产生的 **个人标签** 也应由 **标签管理员** 或受控的员工创建流程维护
- **员工智能体** 可以做 **标签推荐**，但推荐结果必须来自 **标签清单**
- **标签推荐** 默认需要员工确认或受信流程确认后，才能写入资料目录记录
- **员工智能体** 不应在无确认时自动给资料添加 **全员可见标签**
- 普通员工和 **员工智能体** 通过 **权限过滤查询** 访问资料；无权限资料表现为不存在
- 普通查询结果不暴露无权限资料的标题、数量、文件名或存在性
- **后端强制权限过滤** 是所有查询入口的统一边界，不能依赖 MCP、CLI、网页或员工智能体自行过滤
- **员工访问令牌** 继承对应员工账号权限，不创造独立智能体身份
- 删除资料时不物理删除 **文件对象存储** 中的文件，而是将对应 **资料目录记录** 标记为 **归档资料**
- **归档资料** 默认不参与普通查询、搜索和智能体检索，但管理员仍可追溯
- 资料上传后先成为 **待处理资料**，经过处理后进入 **活跃资料** 或 **处理失败资料**
- **待处理资料** 不参与普通查询、搜索和智能体检索
- **处理失败资料** 不参与普通查询、搜索和智能体检索，只对上传者和管理员可见
- 资料处理失败应有限重试；多次失败后保留错误摘要、最后失败时间和重试次数，等待管理员手动处理或重试
- **处理运行** 必须支持幂等重试，避免重复生成派生索引或结构化数据
- **派生索引** 必须能追溯到来源 **资料目录记录**
- 当资料成为 **归档资料** 时，来自该资料的 **派生索引** 也必须退出普通查询、搜索和智能体检索
- **派生索引** 不是权威资料库，命中后仍需校验来源资料状态和访问权限
- **结构化数据集** 必须能追溯到来源 **资料目录记录**
- 企业资料中枢不提供原地 **资料更新** 语义；需要更新资料时，应执行 **资料替换**
- **资料替换** 不覆盖旧文件，而是归档旧资料目录记录并创建新的资料目录记录，即使新旧文件名相同也如此
- **资料替换** 不记录新旧资料之间的替代关系；新资料和旧资料是彼此独立的资料目录记录
- **审计日志** 只能追加，不能被普通管理员修改；纠错应追加新的纠错事件
- **审计日志** 至少覆盖上传、下载、查询、标签变更、状态变更、归档、手动重试、管理员查看失败资料和员工访问令牌创建/撤销
- **管理员后台** 第一阶段只承担资料查看、失败处理、归档查看、标签清单维护、员工账号启停、员工标签维护、审计查询和 Skill 目录维护
- 普通员工网页第一阶段只保留必要的上传、标签确认和查看自己上传资料状态，不建设完整知识库门户
- 第一阶段采用 **模块化单体**，并用 **异步处理 Worker** 处理资料解析和索引构建
- 第一阶段采用 **单企业部署**；可以预留组织字段，但不提供真正多租户 SaaS 能力
- **派生索引** 可从权威元数据和文件对象存储中重建，不作为不可丢失的权威数据
- **文件对象存储** 默认不做物理删除；如因合规或误传敏感文件必须删除，应由管理员受控确认并留下审计日志

## Example Dialogue

> **Dev:** “周报是企业资料中枢每天自动生成吗？”
> **Domain expert:** “不是。企业资料中枢只提供统一资料。周报由员工智能体或未来独立的常规报告服务生成。”

> **Dev:** “用户问‘差评怎么处理’，企业资料中枢会直接回答吗？”
> **Domain expert:** “不会。员工智能体可以分别检索‘差评处理 SOP’、‘客户反馈跟进’等内容；中枢只返回相关证据，由员工智能体回答用户。”

> **Dev:** “员工问某个菜在指定日期卖了多少，企业资料中枢需要知道用户原话吗？”
> **Domain expert:** “不需要。员工智能体只需提交菜品和日期等结构化条件，中枢返回匹配数据。”

> **Dev:** “5A 菜单规则应该直接写进企业资料中枢吗？”
> **Domain expert:** “不一定。5A 菜单规则更应该跟菜单分析 skill 一起版本化；企业资料中枢可以记录这个 skill 的位置和说明。”

> **Dev:** “员工智能体怎么知道现在有哪些可用 skill？”
> **Domain expert:** “通过企业资料中枢提供的 Skill 获取入口查询，例如获取 skill 列表、安装方式和使用范例。”

> **Dev:** “张经理用 Codex 和 OpenClaw 访问资料中枢时，是两个权限身份吗？”
> **Domain expert:** “不是。它们都继承张经理这个员工账号的权限，就像一个 Google 账号可以登录多个 Google 应用。”

> **Dev:** “店长能不能看其他门店的经营报表？”
> **Domain expert:** “默认不能。店长通常只拥有自己门店的归属标签，除非资料额外带有他的个人标签或全员可见标签。”

> **Dev:** “一份资料同时带有苏州街店和张纵个人标签，张纵不是苏州街店员工也能看吗？”
> **Domain expert:** “能看。归属标签是任一命中即可访问，个人标签可以作为点名分享。”

> **Dev:** “张纵上传资料后，系统是否自动给资料打张纵个人标签？”
> **Domain expert:** “是。上传者会被记录为审计字段，同时默认添加上传者个人标签，保证他自己能继续访问。”

> **Dev:** “无标签资料是不是所有人都能看？”
> **Domain expert:** “不是。无标签是异常状态，普通员工默认不可访问，需要管理员补标签。”

> **Dev:** “智能体上传资料时识别到一个新门店名，可以自动创建标签吗？”
> **Domain expert:** “不可以。它只能选择标签清单里的已有标签；新标签需要标签管理员维护。”

> **Dev:** “员工离职后，他的个人标签要删除吗？”
> **Domain expert:** “不删除。员工账号禁用，个人标签保留，历史资料的归属和审计不能被改写。”

> **Dev:** “删除一份上传过的报告时，会把 OSS 上的文件删掉吗？”
> **Domain expert:** “不会。企业资料中枢只把资料目录记录标记为归档，真实文件仍保留在文件对象存储里。”

> **Dev:** “资料归档后，智能体还能从向量检索里搜到里面内容吗？”
> **Domain expert:** “不能。派生索引必须跟随来源资料退出普通检索。”

> **Dev:** “员工重新上传同名 Excel，是更新原文件吗？”
> **Domain expert:** “不是。系统应理解为归档旧资料并上传新资料，两者是不同的资料目录记录。”

> **Dev:** “新上传的文件要记录它替代了哪份旧文件吗？”
> **Domain expert:** “不需要。替换只是两个独立动作，不维护版本链或替代关系。”

> **Dev:** “智能体能根据文件名自动给资料打保利店标签吗？”
> **Domain expert:** “可以推荐，但不能直接拍板。标签必须来自标签清单，并经过员工或受信流程确认。”

> **Dev:** “张纵查询苏州街店资料时，能知道有资料但自己无权看吗？”
> **Domain expert:** “不能。普通查询只返回他有权限的资料，无权限资料表现为不存在。”

> **Dev:** “资料刚上传成功但还没完成索引处理，员工智能体能查到吗？”
> **Domain expert:** “不能。资料要等必要处理完成后才成为活跃资料，进入普通查询和检索。”

> **Dev:** “MCP 已经过滤过权限了，后端还需要再过滤吗？”
> **Domain expert:** “需要。权限过滤必须由企业资料中枢后端强制执行，任何入口都不能绕过。”

> **Dev:** “向量库里搜到了某段内容，可以直接返回给员工智能体吗？”
> **Domain expert:** “不可以。向量命中后还要校验来源资料是否活跃，以及当前员工账号是否有归属标签权限。”

> **Dev:** “普通员工需要一个完整网页知识库门户吗？”
> **Domain expert:** “第一阶段不需要。普通员工主要通过员工智能体使用资料中枢，网页只做上传、确认标签和查看自己上传资料状态。”

## Flagged Ambiguities

- “支持 RAG”可能被理解为企业资料中枢直接生成问题答案；已 resolved：这里指作为员工智能体的 **证据检索** 底座，中枢只接收检索查询并返回可追溯证据或结构化数据，不接收用户原始问题，也不生成最终自然语言答案。
- “证据检索 API”可能被误解为返回自然语言回答；已 resolved：API 只返回 evidence results，包括 chunk text、source metadata、retrieval metadata、model metadata 和 rerank 状态。
- “文档何时进入证据检索 active”已 resolved：MD/TXT/DOCX 必须等完整 hybrid evidence index ready 后才 active；任一索引路径失败都不可检索。ADR 0011 记录该决策。
- “文档切块”可能被简化成固定长度切块；已 resolved：MD/TXT/DOCX 必须按文件类型做结构/语义感知切块，固定长度只允许作为异常 fallback，并需记录在 metadata 中。
- “OCR/图片内容是否进入 Phase 3”已 resolved：不进入。Phase 3 只做 MD/TXT/DOCX 文本证据提取；DOCX 表格文本化，图片/截图只检测并 warning。ADR 0013 记录该范围边界。
- “支持文件类型”可能因旧代码残留出现歧义；已 resolved：新 Phase 3 只支持 MD/TXT/DOCX/XLSX/CSV，JSON 暂不支持，实施时应删除旧 JSON 文本处理逻辑。
- “五种文件是否走一个泛化 upload endpoint”已 resolved：底层统一 `Document`/OSS/audit/worker，HTTP 表面分 evidence upload 和 structured import；metadata 和 active gate 分别由 `DocumentIndex` / `ImportBatch` 决定。
- “MCP 是否 baseline 上传 evidence docs”已 resolved：baseline MCP 同时支持 structured upload 和 evidence document upload；两者都必须走 HTTP API 和后端权限/校验。
- “Phase 3 优先级”已 resolved：核心 baseline 只包含安全上传/处理/授权/检索/查询所必需能力；可观测、诊断、调优和操作体验进入 P2；OCR、PDF、跨表分析、自然语言 query 生成、报告/dashboard、自动替换导入等进入 P3。
- “Phase 3 worker 架构”已 resolved：使用类型化 ProcessingRun、DB lease、幂等 job key、retry/backoff 和 publish gate；operator UI、priority queue、dead-letter UI、adaptive concurrency 等进入 P2。ADR 0016 记录该决策。
- “Phase 3 运维监控”已 resolved：baseline 需要 MySQL/Qdrant/OSS/worker/model provider readiness、核心指标和告警；dashboard、自动修复、成本预算等进入 P2，进入 runbook/implementation docs 而非 ADR。
- “Qdrant 是否只是可选实验依赖”已 resolved：不是。Qdrant 是 Phase 3 baseline 依赖；local compose/bootup、真实 Qdrant 集成测试和 staging/prod-like readiness gate 都必须覆盖。ADR 0017 记录该决策。
- “自托管 Qdrant 是否需要 Qdrant Cloud 订阅”已 resolved：baseline 不需要。Qdrant OSS 标注 Apache-2.0 license，自托管成本主要来自我们自己的基础设施和运维；正式商用仍应保留常规开源合规审查。
- “Qdrant Cloud 是否能在中国大陆/阿里云无缝使用”已 resolved：不能作为假设。Phase 3 默认大陆/阿里云自托管 Qdrant，并通过镜像 pinning/ACR 同步保证部署可重复；托管/Hybrid/Private 方案需另行验证后才可替换。ADR 0017 记录该边界。
- “CI 是否必须调用真实外部模型 provider”已 resolved：不必须。默认用 deterministic fake embedding/rerank provider 跑真实 Qdrant/MySQL 集成测试；真实 provider smoke 使用合成文本，在 manual/nightly/staging preflight 中跑。
- “Phase 3 MCP 边界”已 resolved：MCP 继续作为 HTTP API 薄适配，提供员工智能体需要的检索、schema discovery、结构化查询、结构化上传和状态查询；admin/operator/reindex/model/schema 控制不进入 MCP。
- “插入新 Phase 3 后是否只改 implementation-plan”已 resolved：不可以。需要 phase renumbering impact audit，检查 implementation、readiness、ADR、AGENTS、env/deployment、API/MCP/test/docs/scripts 中的 Phase 3/4 引用。
- “旧 phase-3-readiness.md 是否直接改名”已 resolved：按用户确认重命名为语义化 `staging-readiness.md`；历史日志里的旧路径保持历史含义。
- “向量检索”可能被误解为只存 embedding；已 resolved：向量索引需要保存 embedding、可返回文本片段、来源位置、模型版本和权限/metadata 过滤字段，同时由事务型数据库继续维护权威资料状态。
- “chunk id 是否可以只用文档 id 或 ordinal”已 resolved：不可以。`chunkId` / Qdrant point id 必须绑定 `documentId`、`contentVersion`、`retrievalConfigVersion` 和 `chunkOrdinal`，这样内容替换和模型/索引迁移不会混淆旧证据。
- “Qdrant payload snapshot 是否可授权”已 resolved：不可以。payload snapshot 只用于预过滤/诊断；返回前必须回 MySQL 校验 document active、contentVersion、index ready、当前标签权限和员工状态。
- “内容替换时旧内容是否继续可查”已 resolved：Phase 3 baseline 采用严格语义，替换期间不可查，直到新内容版本索引 ready；无中断双版本替换进入 P2。
- “MySQL 与向量库职责”可能被混在一起；已 resolved：MySQL 存权威元数据和 CSV/XLSX 结构化行数据，向量数据库存 MD/TXT/DOCX 文档检索索引。两者通过 id/metadata 关联做权限、状态和追溯校验，但不互相替代。
- “Qdrant payload filter 是否可作为权限判断”已 resolved：不可以。它只是检索优化，所有返回 chunk 必须经过 MySQL 权威状态和权限复核。ADR 0010 记录该安全边界。
- “向量库选型”已 resolved：新 Phase 3 默认使用 Qdrant。Milvus 作为未来超大规模/GPU/重集群需求的替换候选，pgvector 因当前权威数据库不是 PostgreSQL 暂不作为默认方案。
- “词法索引位置”已 resolved：Phase 3 默认使用 Qdrant sparse/native hybrid，避免新增第三个检索存储；通过 adapter 保留未来迁移到专用 lexical engine 的路径。ADR 0012 记录该决策。
- “证据检索质量验收”已 resolved：Phase 3 需要 golden retrieval suite 和指标门禁；权限/状态泄露零容忍，并比较 dense-only、lexical-only、hybrid、hybrid+rerank 基线。该内容进入验收/test 文档，不单独建 ADR。
- “embedding/rerank 模型来源”已 resolved：Phase 3 允许使用配置化外部 API，通过 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_EMBEDDING_MODEL`、`OPENAI_COMPATIBLE_API_KEY`、`OPENAI_COMPATIBLE_BASE_URL` 控制；模型供应商不能写死，密钥不能输出或提交。
- “模型相关 env 是否要改名”已 resolved：baseline 继续支持现有 `LLM_*` / `OPENAI_COMPATIBLE_*` 变量以保持简洁；可在实现或文档中增加更明确的 embedding/rerank alias，但不能要求当前 `.env` 改名。
- “哪些配置放 env，哪些放 DB/versioned config”已 resolved：env/secrets 放连接、密钥、部署限流；retrieval config、field registry、模型/索引/chunker 版本放 DB 或代码种子化 versioned config，并由 response/index metadata 引用。
- “embedding/rerank 模型迁移”已 resolved：模型和配置是版本化检索基础设施，必须并行重建、评估、promote、保留 rollback 版本；不能静默混用新 query embedding 和旧向量。ADR 0014 记录该决策。
- “外部模型数据出境”已 resolved：embedding/rerank provider 需要管理员显式配置和确认；payload 最小化，默认不记录原文，不跨 org 批量，不静默 fallback。ADR 0015 记录该安全边界。
- “rerank 是否必需”已 resolved：Phase 3 必须真实接入 rerank provider；效果调优可以后置，但 adapter、provider、config、调用链和状态记录不能缺。local/CI 可用 fake rerank，非 rerank 结果必须明确标记。
- “结构化查询”可能被理解为允许调用方提交 SQL；已 resolved：采用 **受控结构化查询**，只开放服务端定义的只读字段、运算符、分页，以及调用方显式请求的纯机械分组和聚合，不接受 SQL，也不提供任何数据修改能力。
- “结构化查询 API”可能被误解为分析服务；已 resolved：它只像 BI 数据提供层一样返回调用方 query 请求的数据和字段定义，不知道上游用户问题，也不生成趋势、结论或建议。
- “结构化查询一次返回全量明细”已 resolved：必须分页并设置单次上限，调用方智能体需要完整数据时通过 cursor 分页拉取。
- “结构化分页是否需要跨页 snapshot”已 resolved：baseline 不提供长事务 snapshot；每页重新授权。cursor 绑定权限/query/registry/sort/active import scope，scope 变化时 cursor 失效。
- “结构化查询复杂度是否可无限放开”已 resolved：不可以。baseline 有 max limit/depth/conditions/in/sort/group/aggregate/select，并在 SQL 执行前拒绝超限或高成本查询。
- “operator 支持”可能被误解为允许调用方拼接查询；已 resolved：对外是可读 JSON API / query wrapper 风格结构，内部编译为参数化 SQL，所有 dataset、field、operator、sort、pagination 和 aggregation 都由服务端 allowlist 校验。
- “结构化 API 错误模型”已 resolved：使用稳定机器可读错误 envelope 和 registryVersion 兼容语义；权限隐藏数据返回空结果或被 scope out，不用错误泄露。细节进入 API contract/test docs。
- “Phase 3 HTTP 和 MCP 谁是权威契约”已 resolved：HTTP API 是唯一权威后端契约；MCP 只是薄适配，不直连存储、不复制权限/查询校验、不暴露 admin/operator 能力。ADR 0018 记录该边界。
- “分页是否可以暴露 offset”已 resolved：baseline 采用 opaque cursor；cursor 内部绑定调用方、org、query shape、registry version 和 sort，不泄露 DB/Qdrant 实现细节。
- “复杂条件查询”已 resolved：支持受控 `and` / `or` 条件树，但必须限制深度、条件数和列表长度；具体阈值后续在 API contract 和实现中确定。
- “显式聚合”可能被误解为指标/分析服务；已 resolved：Phase 3 只支持逐字段 allowlist 的机械聚合函数，不支持公式、窗口函数、跨表 join、派生业务指标、趋势判断或自然语言结论。
- “日期口径”可能被误解为企业资料中枢需要从用户自然语言里判断字段；已 resolved：中枢只定义并暴露字段/API，调用方智能体负责把用户意图映射到 `order_time`、`business_date` 等具体字段。
- “菜品名扩展”可能被误纳入新 Phase 3 的核心能力；已 resolved：先不做结构化实体扩展，新 Phase 3 只要求确定性的受控结构化查询能力，菜品名扩展作为低优先级后续功能。
- “表格部分导入”可能看起来更宽容；已 resolved：菜品数据和营业数据采用整份文件原子失败，避免调用方查询到不完整的权威数据。校验器需要足够 robust，字段可空性和类型规则要参考真实导出样本定义。
- “结构化导入错误信息”已 resolved：对调用方返回可操作的阶段/表/行/字段/原因和有限样例，不返回内部堆栈。
- “结构化 schema 覆盖范围”已 resolved：菜品和营业表及结构化 API 字段注册表必须完整覆盖当前真实导出列集合；完整覆盖通过逐字段能力注册实现，不代表每个字段都可任意过滤、排序、聚合或 `contains` 查询。ADR 0007 记录该决策。
- “真实样本 profiling 是否可直接成为生产 schema”已 resolved：不可以。样本只生成候选 profile/registry diff，生产契约必须人工 review 后固化到 MySQL migration 和 versioned field registry。
- “未来新增/删除/改名列是否自动接受”已 resolved：baseline 不自动接受。未知列、缺失 required 列和模糊改名列都会失败；确认后通过 registry version bump、migration 和测试进入系统。
- “结构化 schema discovery”已 resolved：Phase 3 提供 `GET /structured/datasets` 一类 discovery API，调用方智能体基于字段注册表和 dataset 限制构造查询，而不是硬编码字段能力。
- “上传文件名”可能被误用为业务判断依据；已 resolved：用户上传文件名只保存为原始元数据，系统内导入批次名和 OSS 结构化源文件副本使用 `{enterprise_name}_{dataset}_{start_date}_{end_date}` 规范化名称，不按营业日拆分；`enterprise_name`、`dataset`、`start_date` 和 `end_date` 来自上传接口 metadata；日期范围指营业日范围，表格类型和日期范围由内容结构、上传元数据和校验逻辑确认。
- “enterprise_name 是否是业务主键”已 resolved：不是。结构化导入沿用现有 `Organization.id` / `orgId` 作为企业级主键和权限边界，`enterprise_name` 仅用于展示和规范文件名组件。
- “结构化导入是否需要 ImportBatch”已 resolved：需要。`Document` 表达源文件，`ImportBatch` 表达一次结构化导入尝试/结果和日期窗口，行表、ProcessingRun、审计日志都应关联该批次。ADR 0008 记录该决策。
- “结构化行权限”已 resolved：结构化行继承源 `Document` 标签权限，权限 scope 必须在过滤/聚合/分页前应用；Phase 3 不建立独立行级标签系统。ADR 0009 记录该安全边界。
- “dataset 类型”可能被系统从内容里自行选择；已 resolved：metadata 必须显式提供 `dataset: dishes | business`，系统只校验内容 schema 是否与声明一致，不替调用方猜测。
- “metadata 日期范围”可能被误以为可由系统自动修正；已 resolved：metadata 是调用方声明，系统只做一致性校验。表内营业日范围必须与 metadata `start_date` / `end_date` 严格一致，否则整份文件失败。
- “表头 alias”可能被误解为模型语义理解；已 resolved：alias 是静态、受控的表头到 canonical 字段映射，例如 `营业日 -> business_date`，不做语义猜测。列顺序可变，但未知额外列、必需字段缺失和重复映射都会失败。
- “表头固定在第 3 行”不应成为导入假设；已 resolved：CSV/XLSX 校验器扫描前 10 行寻找唯一合法表头，找不到或多候选都失败。
- “XLSX 只能有一个数据表”不成立；已 resolved：允许多个 sheet，但每个参与导入的 sheet 必须满足同一 dataset schema 和同一 metadata 营业日范围，不能混合菜品/营业 schema。
- “说明 sheet/隐藏 sheet 是否可忽略”已 resolved：只有完全空 sheet 可忽略；任何非空 sheet，包括隐藏 sheet，都必须匹配同一 dataset schema 和营业日范围。匹配的隐藏 sheet 参与导入，不匹配则整份失败。
- “结构化导入验收”已 resolved：使用真实大文件和 adversarial fixtures 验证完整字段覆盖、nullable/type 规则、多 sheet、metadata 一致性、原子失败、ImportBatch/idempotency、权限继承和性能；该内容进入 acceptance/test 文档，不单独建 ADR。
- “重复上传是否自动覆盖”已 resolved：同一 `{orgId, dataset, start_date, end_date}` 已有 active/applied 导入时，新上传直接失败，不自动覆盖、不追加、不复用；同 idempotency key + 同 request fingerprint 的重试只返回已有批次状态。替换导入作为未来单独能力设计。
- “结构化源资料归档后 rows 是否删除”已 resolved：不删除也不可查询。rows 可保留作审计/排障，但所有明细、聚合、分页都必须通过 source Document active/permission scope。
- “错误 active import 如何恢复”已 resolved：baseline 使用显式 archive old + upload new；atomic replace/overwrite/append 是 P2/P3。ADR 0019 记录该生命周期边界。
- “结构化 hard delete/purge 是否进入 baseline”已 resolved：不进入。生产 purge 需要单独 admin/security/retention 设计。
- “OSS 是否按营业日拆分结构化源文件”已 resolved：不拆分。校验通过后按导入批次规范名保存源文件副本，行级查询能力由 MySQL 表提供。
- “结构化上传何时 active”已 resolved：OSS 保存、schema/metadata/row 校验、MySQL 原子写入、导入批次/资料目录/审计记录全部成功后才 active；任一失败都不可结构化查询。
- “这个服务”“中心化服务”容易被理解为专用智能体平台；已 resolved：这里指 **企业资料中枢**，只做资料沉淀、访问、维护和追溯，不做复杂分析和报告生成。
- “经营资料中枢”命名过窄，容易让人以为只管理经营数据；已 resolved：统一改称 **企业资料中枢**，因为它也管理会议、培训、管理知识和 Skill 目录。
- “经营规则”容易被理解为资料中枢里的独立文本规则；已 resolved：多数经营规则应归属到具体 **业务 Skill**，由 skill 定义、版本化和使用，企业资料中枢可通过 **Skill 目录** 管理获取方式。
- “智能体凭证”暂不作为第一阶段权限主体；已 resolved：权限按 **员工账号** 判断，不按不同应用或智能体拆分。
- “账号”可能同时指登录凭据和资料权限主体；已 resolved：**登录身份** 由当前 **身份验证方** 验证，**员工账号** 是企业资料中枢内唯一的资料权限主体，两者通过稳定主体标识映射。
- “邮箱相同即可绑定员工权限”已 rejected：邮箱只是可修改的 **登录标识**；登录身份必须通过稳定 `employeeId` 显式绑定员工账号，不能按邮箱自动创建或自动绑定。
- “数据模型允许多个登录身份”不等于 beta 必须提供多身份管理；已 resolved：模型不锁死为一对一，但当前产品只支持每个员工账号一个启用的本地密码身份，不实现添加、切换或自助关联多个身份的入口。
- “员工账号和登录身份分开建”容易留下无法登录或没有权限的半成品；已 resolved：普通 beta 入驻命令原子创建员工账号、个人标签和唯一启用的本地密码登录身份，任一步失败则全部回滚。
- “登录邮箱怎么判重”已 resolved：登录标识在部署内全局唯一，去除首尾空格且完整地址不区分大小写；不做删除点号、删除 `+suffix` 等服务商特有转换，公开登录失败也不能泄露该邮箱是否存在。
- “错误密码是否永久锁号”已 resolved：前五次可连续失败，此后按 5、10、20、40、60 分钟等待并保持 60 分钟上限；冷却期间的请求不增加计数或延长时间，成功登录或完成开发者发起的密码重置后清零。
- “账号停用/恢复/删除”不属于当前正式登录切片；已 deferred：beta 不提供员工入口或管理后台流程，未来最多先增加开发者 CLI 紧急操作，硬删除如何处理历史资料与审计记录另行设计。
- “浏览器登录后 launcher 怎么知道成功”已 resolved：launcher 临时监听 `127.0.0.1` 随机端口并使用 Authorization Code + PKCE；浏览器只把单次授权码送回精确回调地址，launcher 校验 `state` 后通过 HTTPS 换取凭证。
- “登录页面是否需要独立前端服务”已 resolved：由现有 Fastify API 在当前 HTTPS origin 返回少量服务端 HTML；成功页由 launcher 的本机回调返回，不引入独立前端部署。
- “浏览器是否也要保持长期登录”已 rejected：浏览器状态只服务于当前授权事务；持久会话属于 launcher，授权码交付后关闭页面或清空 Cookie 不影响后续使用，交付前中断则安全地重新开始登录。
- “短期 access token 从哪里来”已 resolved：它由 Enterprise Hub token 接口在授权码 + PKCE 交换成功后签发，有效期 10 分钟且只驻留 launcher 内存；它不是密码、浏览器 Cookie、阿里云或 GitHub 凭证。
- “access token 是 JWT 还是随机字符串”已 resolved：正式 token 使用至少 256 位随机强度的不透明字符串，服务端只存哈希并按请求查询；token 不携带可解码的员工、组织或权限声明。
- “launcher 多久需要重新登录”已 resolved：长期会话固定为浏览器密码登录后的 30 天，不另设闲置超时且不能滑动延长；到期后 launcher 自动重新打开浏览器。
- “长期凭证是否固定不变”已 rejected：每次续取 access token 都返回新长期凭证并消费旧值；旧值再次出现即视为可能复制并撤销整个会话家族，不设置重放宽限期。
- “系统安全存储不可用时是否写普通文件”已 rejected：launcher 必须停止认证并给出安全提示；长期凭证只允许进入 Keychain 或 Credential Manager，缺失记录只表示未登录。
- “同一台电脑上的不同 Agent 是否分别登录”已 rejected：同一操作系统用户下的所有 Agent 共享一个 Enterprise Hub 账号和安全存储记录；beta 假设用户只有一个账号，不设计账号切换或多账号操作。
- “launcher 是否需要动态注册客户端”已 rejected：所有 official launcher 使用一个固定 public client 和固定 Enterprise Hub API/MCP 资源；服务端只提供授权码 + PKCE、token 与 metadata 契约。
- “launcher 源码应该放在 skills repo、独立 repo 还是主仓库”已 resolved：源码留在产品主仓库并作为公开版本化 npm 包发行；skills repo 只保留安装/使用指导和批准版本。
- “谁执行 launcher 安装和 MCP 配置”已 resolved：skill 负责给出权威步骤，员工拥有的 agent 执行；launcher 不自行修改系统，员工也不需要亲自运行命令。
- “是否只能支持预先写死的 agent”已 rejected：Codex 与 OpenClaw 是首批正式验收对象，但 skill 必须允许其他具备本地 MCP 能力的 agent 根据自身帮助和配置进行受约束的自适应安装；未经端到端验收时只是不承诺正式支持。
- “launcher 是否自行升级”已 rejected：launcher 只报告版本并读取服务端兼容策略；何时升级以及升级到哪个精确批准版本都由保持同步的两份 skills 指导 agent 完成，实施时必须同时大幅更新主仓库和独立 skills repo。
- “退出登录、移除单个 agent、彻底卸载是否等价”已 rejected：退出登录影响共享本机会话，移除单个 agent 只改其 MCP 配置，彻底卸载才清理所有本地集成；服务器员工账号和业务数据始终保留。
- “长期凭证轮换后写不进系统安全存储怎么办”已 resolved：撤销或放弃该会话并要求重新进行浏览器登录；最坏结果是多登录一次，绝不把凭证写入普通文件或继续使用已消费旧值。
- “会话失效后用户是否要重新描述原任务”已 rejected：launcher 返回 `authentication_required`，skill 指导 agent 完成浏览器登录，然后由 agent 自动重试原 MCP 操作一次；网络、权限和版本错误不得误触发登录。
- “四五个 beta 用户是否需要会话清单和单设备撤销”已 deferred：当前不做相关 CLI/UI；丢失设备时沿用密码重置流程，并在新密码设置成功后撤销全部旧会话。
- “没有会话管理页面是否还要保留身份安全记录”已 resolved：保留 90 天无凭证内容的最小安全审计供事故排查，读取仅限 operator；不扩展为 beta 仪表盘、用户历史或实时告警。
- “最小 beta 是否还要增加 IP/端点级限流”已 deferred：当前不做，单身份递进冷却是唯一登录尝试限制；验证码和外部反机器人服务同样暂缓。
- “单因素密码最低是否使用 NIST 建议的 15 字符”已 rejected for beta：产品决定最低 8 字符、最高 128 字符，其他无组合规则、常见密码拦截、完整验证和 Argon2id 存储要求保持不变。
- “是否保留本地测试用 dev-login/JWT”已 rejected：旧认证实现完全弃用并删除，不设计迁移或双栈兼容；测试同样使用新系统的正式凭证模型，只能通过内部 fixture/factory 加速准备。
- “CLI 重置密码”可能被理解为开发者设置或掌握员工密码；已 resolved：beta CLI 只签发 **密码设置链接**，密码始终由员工本人在浏览器页面设置。
- “Phase 3 MCP 连接鉴权”已成为历史实现：当前 staging 已运行公开 HTTPS MCP、浏览器 Authorization Code + PKCE、不透明 access token 和系统安全存储长期会话，不保留 development email/JWT 兼容路径；固定版本 `enterprise-hub-mcp-launcher@0.1.0` 已在 npm 发布，真实浏览器与 macOS/Windows 桌面验收仍是发布门。
- “权限管理”容易被过度设计成逐字段或逐文件控制；已 resolved：第一阶段采用 **粗颗粒度权限**，只以 **归属标签** 是否命中判断访问。
- “归属”不应设计成单选组织范围；已 resolved：资料和员工账号都使用多值 **归属标签**，任一标签命中即可访问。
- “区域标签/门店标签继承”暂不采用；已 resolved：第一阶段保留 **门店标签**，不做区域标签，也不做自动展开。
- “无标签即全员可见”存在误传敏感资料的风险；已 resolved：使用显式 **全员可见标签** 表示公开资料，**无标签资料** 是异常状态，普通员工默认不可访问。
- “上传者”和 **个人标签** 容易混淆；已 resolved：上传者是审计字段，个人标签是权限标签，资料上传时默认自动添加上传者个人标签。
- “资料类型权限”暂不作为第一阶段权限维度；已 resolved：**资料类型** 只用于分类和检索，不参与权限判断。
- “标签自由创建”会导致权限和检索失控；已 resolved：所有 **归属标签** 来自受控 **标签清单**，只能由 **标签管理员** 维护。
- “离职员工资料归属”不应通过删除或复用个人标签处理；已 resolved：禁用 **离职员工账号**，保留其 **个人标签** 和历史资料归属。
- “删除资料”不代表删除 OSS 原始文件；已 resolved：企业资料中枢以 **资料目录记录** 的状态变化表达归档，不做默认物理删除。
- “归档资料仍被向量检索命中”会造成语义错误；已 resolved：**派生索引** 必须追溯来源资料，并随来源资料归档而退出普通检索。
- “资料更新”不作为第一阶段系统原语；已 resolved：更新业务被建模为 **资料替换**，即归档旧资料并上传新资料。
- “资料替换关系”不作为第一阶段系统概念；已 resolved：不记录新旧资料之间的版本链、替代关系或 replaces 字段。
- “智能体自动打标签”容易变成自动授权；已 resolved：智能体只能做 **标签推荐**，写入标签需要确认，且不能创建新标签。
- “无权限资料存在性”不应暴露给普通员工或员工智能体；已 resolved：普通查询使用 **权限过滤查询**，无权限资料表现为不存在。
- “上传成功即活跃”暂不采用；已 resolved：资料上传后先作为 **待处理资料**，处理完成后才成为 **活跃资料**。
- “入口过滤权限”不足以保证安全；已 resolved：权限过滤必须由 **后端强制权限过滤** 统一执行。
- “向量索引命中”不等于可返回；已 resolved：向量检索结果必须回到来源资料校验活跃状态和员工账号权限。
- “企业资料中枢前台”不作为第一阶段主产品；已 resolved：普通员工网页只保留上传、标签确认和状态查看，主要使用入口仍是员工智能体。
- “多企业 SaaS”暂不作为第一阶段目标；已 resolved：采用 **单企业部署**，最多预留组织字段，不实现真正多租户隔离。
