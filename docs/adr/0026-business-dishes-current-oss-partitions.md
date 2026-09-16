# Business / Dishes 采用 OSS 当前分区而非 MySQL 明细行

**Status**: Accepted; implemented locally, release/cutover pending.

`business` 和 `dishes` 的真实来源文件可能包含数十万至上百万行。把每个来源行展开成一条 MySQL JSON row，会让一次普通上传产生大规模事务写入，也会迫使周报、月报通过受控查询和分页反复扫描、传输大量明细。真实规模验收已经证明，这条路径同时放大数据库事务、清理、MCP 调用次数和员工智能体上下文成本；企业资料中枢并不需要为这两个只供本地分析的完整日数据集提供逐行在线 OLTP 能力。

**Decision**: `business` 和 `dishes` 硬迁移为“OSS 保存当前标准化分区文件，MySQL 只保存分区目录与任务元数据”。每个成功导入按 `{orgId, enterpriseKey, dataset, storeKey, businessDate}` 切成门店/整日 CSV 分区；`merchant:<商户号>` 是首选 `storeKey`，没有商户号时才使用 `name:<规范化门店名>`。`enterpriseKey` 由上传的企业名规范化得到，因此同一组织可以保存多个企业的数据。`businessDate` 是完整营业日；来源中没有出现的门店/日期不生成空分区，也不删除已有的其他分区。

来源 XLSX/CSV 只作为临时导入载荷存在。launcher 以一次自然语言触发的一次 MCP 工具调用启动可恢复分片上传；文件字节绕过模型上下文，经预签名 multipart 直传临时 OSS object。worker 流式校验并生成固定表头、固定编码和确定性标量格式的 canonical CSV，先把一个源文件的全部候选分区上传并校验，再在一个短 MySQL 事务中发布所有当前指针。任何分区失败都会使该源文件整体失败；同一次用户请求中的 `business` 与 `dishes` 两个源文件各自独立原子提交。

这两种来源由固定程序生成；表头上方允许存在不承载业务数据的展示说明和合并单元格，但 canonical 表头与数据区域不使用合并单元格。分区导出因此跳过 XLSX 合并区域预扫描与填充，只扫描前十行定位 canonical 表头，并且不把表头上方的标题、查询条件或其他说明行写入分区 CSV。通用 XLSX 读取器仍保留合并单元格展开能力，供其他数据集按需使用。

上传任务持久化用户声明的起止营业日；worker 拒绝任何包含区间外营业日的来源，防止文件名或调用参数错误静默发布到意外日期。声明区间内没有出现的门店/日期仍按“没有数据”处理，不要求首尾日期一定出现。

分区唯一键重叠时，新一次成功提交覆盖当前分区，包括覆盖其密级；不保留旧版本、历史指针或 rollback copy。相同 canonical CSV 字节以 SHA-256 判定：内容和当前元数据均相同时不改目录或 object；内容相同但密级或展示元数据变化时复用 object 字节并原子更新当前目录元数据；内容不同时先发布新 object 指针，再异步删除旧 object。并发上传按分区键排序加锁，最后一个成功提交的源文件获胜。读取始终通过 MySQL 当前目录授权，不能从 OSS key 推断权限，因此发布过程没有可见空窗。

成功、拒绝或终态失败后删除临时来源 object 和本地临时文件；可重试状态只在下一次 worker 尝试仍需要载荷时暂留。导入任务只保留有限期运行元数据和安全错误摘要，不保留来源内容。旧 object 删除失败进入可重试垃圾清理队列，但旧 object 不再可查询。

`processing_runs` 的 document/job 二选一 owner 由创建、claim 与完成代码路径强制。MySQL 不允许在带 referential action 的外键列上建立该 CHECK，因此迁移不伪造一个无法部署的数据库 CHECK；两列各自唯一且都受外键约束，仓储 API 不暴露可创建无 owner 或双 owner run 的入口。

`business` / `dishes` 不再支持通用逐行/聚合 `query_structured_dataset`。服务按组织、密级、企业、数据集、营业日和可选门店筛选当前目录，并返回包含逐分区元数据和短期预签名链接的 manifest。官方 launcher 一次性并发下载、校验 byte size 与 SHA-256 到新建的本地临时目录，只把目录和文件摘要返回给员工智能体；失败时删除部分下载。报告 skill 在本地读取这些分区完成分析，并在报告产物生成后用 `finally` 删除下载目录；launcher 另行清理超期遗留目录。

`vip`、`dish_catalog`、`delivery_ledger` 和 `supplier_catalog` 继续使用现有 `Document` / `ImportBatch` / MySQL row-table / controlled-query 生命周期。本 ADR 只取代 ADR 0008、0009 和 0019 中适用于 `business` / `dishes` 的源文档保留、窗口冲突、行血缘、行权限、归档和通用查询决策；它不改变这些 ADR 对其他结构化数据集的约束。ADR 0003 中“清洗后的结构表是派生索引”的通用表述，对这两个数据集改为：canonical OSS 分区是当前权威业务数据，MySQL 分区目录是权威访问与发布元数据。

**Considered Options**: 继续扩大 MySQL 行表和分页查询容量；为每次上传保留原始文件并在请求时现场切分；服务端预聚合周报/月报指标；把 Parquet/ClickHouse 引入本次迁移；让 agent 自己切块或直接调用内部 API；保存多版本分区并提供回滚；让相同日期窗口的上传冲突失败。

**Consequences**: 数据库写入从“每个业务行一行”降为“每个门店/日期一个当前目录行”，报告读取从大量 MCP 查询页变为少量 manifest 请求加本地文件分析，重复和重叠上传自然收敛到同一当前分区。代价是 `business` / `dishes` 不再提供在线逐行查询或服务端聚合，worker 需要流式解析、临时磁盘、multipart、原子指针发布和垃圾回收能力，launcher 与报告 skill 必须同时升级。因为没有真实用户且历史数据全部为 QA，本变更采用一次性清空和直接切换，不实现 backfill、dual write、兼容端点或中间版本。
