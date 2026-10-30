# 经营、菜品销售与订单当前分区契约

`business`、`dishes` 和 `settled_orders` 使用 launcher 临时原件直传、worker canonical CSV、OSS 当前对象和 MySQL 当前目录。Launcher `0.14.0` 已公开发布并独立核验，匹配服务部署已核实，批准安装 pin 为 `0.14.0`；使用仍需当前独立类别授权。当前部署和线上推荐值证据见 [staging 状态](staging-readiness.md)。历史迁移清单不再作为操作入口。

`takeaway_orders`（平台外卖订单明细）已接入同一源码管线，launcher 候选为 `0.15.0`，尚未发布。上述 `0.14.0` 安装 pin 和推荐值保持不变；外卖使用须先独立核验兼容客户端发布、匹配服务部署、前向枚举迁移 `20261030010000_takeaway_orders` 及当前类别授权。无新增环境变量、明细表或对象存储设施。

## 身份与权威数据

分区唯一键为 `(orgId, enterpriseKey, dataset, storeKey, businessDate)`。企业/物理门店键规范化由 `packages/domain/src/structured-partitions.ts` 和 `partition-store-filter.ts` 定义；保留商户号字符串及前导零，没有商户号时使用明确门店名的确定性 fallback。同一物理分区内不一致的门店身份使整份来源被拒绝，不自动合并别名。

物理 storeKey 与当前授权门店名是不同概念。业务授权仍按企业内精确门店名称及完整类别/维度匹配，不能用物理键形成第二套放行规则。只为来源实际出现的门店/日期生成分区；没有出现不表示删除其他已有分区。

OSS canonical CSV 是权威业务数据，MySQL 保存当前指针、行数、字节数、SHA-256、业务身份/权限及发布元数据。不保留分区历史版本、MySQL business/dishes/settled_orders/takeaway_orders 明细表或原始 Excel 下载入口。

## Canonical CSV

- UTF-8 无 BOM，逗号分隔，RFC 4180 引号，LF 换行及末尾换行。
- 使用注册表中 inputSource=file 的固定中文字段和顺序；`settled_orders` 末尾追加派生“结账方式JSON”，合计 31 列。一个表头，至少一行有效数据；不加入 source_document_id 等不存在于 canonical schema 的字段。
- 保留来源 sheet/行顺序；按解析规则排除标题/筛选/汇总行；空 nullable 字段输出空字段。
- 使用确定性的已验证值：日期 YYYY-MM-DD、日期时间 YYYY-MM-DD HH:mm:ss、布尔 true/false、非指数十进制数，身份字段保持字符串语义。
- SHA-256 覆盖确切字节；输出不依赖机器 locale/timezone 或文件名。语义相同但顺序不同的来源可以产生不同 hash。

## 订单来源边界

`settled_orders` 上传必须是所选门店完整单日或多日来源快照；上传方保证业务完整性，服务不能从文件名、标题或筛选说明证明完整。仅替换文件中实际出现的门店日，整份空数据拒绝；重复行/订单号不去重。按来源营业日分区，跨午夜不调整；本来源无商户号，机构编码不代替 merchantId。

全部 30 个输入列必需，允许重排；仅门店和营业日期必填。可空日期/时间/数值中的 `--` 转空，普通文本/编号保留。结账方式保留原文及有序 `{method, amount, marker}` JSON 数组，重复项不合并，退款/找零/撤销找零保留符号与标记，兼容半角和全角括号；空白/`--` 派生 JSON null。非空解析失败或出现不支持的标记时整份拒绝，错误指出源行、从 1 开始的支付项序号和失败原因。金额不补零、不推净额或跨字段对账。字段及员工操作见[订单 reference](../../skills/smedc-mcp/references/settled-orders.md)。

### 平台外卖有效订单

`takeaway_orders` 使用“平台外卖订单明细—有效订单”，不是已完成订单子集。每个提交门店日包含全部平台及全部来源有效订单；当天允许截至导出时刻的完整快照，后续状态/退款变化由上传方重新导出涉及的完整门店日。平台不成为分区或授权维度。

33 个来源列全部必需、允许重排；固定输出恰好 33 列，不追加派生字段。门店及营业日期必填，其余 nullable， typed `--` 转空而普通文本/编号保留；编号沿用字符串处理，金额保留精确值与符号，不推导净额或跨字段纠正。新状态、平台和配送方式作为文本接收，重复行/编号保持来源顺序。来源营业日决定归档，机构编码不作商户号；整份空数据或后部坏行均拒绝，最后成功发布决定当前内容，未出现的门店日保持原样。完整字段及操作见[外卖订单 reference](../../skills/smedc-mcp/references/takeaway-orders.md)。

固定类别初始密级为空、无默认 grant，沿用管理员“补齐资料类别”写路径登记。普通读取必须使用 enabled 模式下当前完整企业/门店/类别/维度/密级；其他经营类别授权和 admin 身份均不授予读取，旧模式没有回退放行。经营汇总可能已包含外卖金额，本地分析不能无条件相加。

## 上传和发布

只有当前有效 admin 可发起/继续上传。官方 MCP 接受原始绝对本地路径及业务元数据；launcher 创建会话、流式 multipart 传输、完成上传并返回 jobId。文件字节、内部链接、ETag 和凭据不经过模型上下文。未完成会话的有效所有者可按现有 abort 契约取消。

默认边界：2 GiB 来源、每份 500 万行、1 万分区、8 GiB canonical 输出；实际运行限制见 [环境变量](env-inventory.md) 与 `packages/domain/src/runtime-limits.ts`。XLSX 由受限 Calamine 子进程解码，TypeScript 适配器验证事件顺序、sheet/row 元数据、尺寸、完成信号和退出状态；CSV/写文件保留流式和有界句柄/缓冲。

源文件是原子边界：全部候选生成、上传并验证后，在短事务内按确定顺序锁定分区并一次发布。并发同键以最后成功提交为准，读取不会看见半份来源或空窗。

| 比较                     | 结果                                 |
| ------------------------ | ------------------------------------ |
| 没有当前键               | 新建当前分区                         |
| 字节和元数据相同         | 保持当前行及对象                     |
| 字节相同、有效元数据变化 | 复用字节并原子更新元数据             |
| 字节不同                 | 切换新指针，旧对象进入精确键垃圾队列 |

当前业务授权启用后，固定类别等级由企业配置决定，旧上传 level 不能覆盖。临时来源在 published/rejected/终态 failed/取消/到期后清理，重试中的任务只在必要期限内保留。失败或失去租约不会替换有效当前数据，也不暴露原先不可读分区的 hash/状态。

## 读取与下载

coverage/manifest 根据当前账号、组织、类别密级、企业、精确门店和全部维度先限权，再应用日期/店名筛选。`query_structured_dataset` 不支持这些分区数据集；分析由调用 agent 在下载后的本地文件上完成。

Range 是默认方式。可选异步 ZIP 必须确认目标服务支持；发现工具名本身不是可用性证明。提交打包时完整授权并固定实际清单，后台制作不因发起人单纯权限变化失败；领取新链接再校验本人当前完整权限与来源。旧清单无法证明身份/内容/范围时要求重新准备。

Launcher 消费内部链接、核验下载文件/清单的身份、checksum、数量和安全提取路径，再返回本地目录及安全摘要。零分区成功生成有效空 extract，失败不能当成无数据。取消/中断清理不完整输出；调用方完成使用后删除临时目录。

日期格式、过滤器、幂等、包限制、重试及错误代码以 [分区 API/MCP 契约](api-contract.md#filtered-partition-extracts-and-asynchronous-bundles) 为准。源/包清理只通过受权运维入口，不能扫描删除整个业务前缀。

## 验证与运维

- 解析/协议：`npm test -- packages/structured-ingestion/src`；真实 reader 验证见该目录 AGENTS.md。
- 事务/租约/清理：`packages/db/src/structured-partitions*`、`apps/worker/src/partition-import.test.ts` 及相关真实数据库集成测试。
- 上传/下载公共路径：API 结构化分区测试、launcher multipart/partition-bundle 测试和 MCP smoke。订单合成 XLSX 主链路复用 `npm run test:integration -- --settled-orders-only` / `--takeaway-orders-only`，需现有 loopback MySQL、匹配 `MYSQL_PORT`/`DATABASE_URL` 与真实 `SMEDC_CALAMINE_READER_PATH`；runner 使用独立临时 schema 并清理。
- 性能比较使用同一 fixture/workload；[历史基准](dishes-business-partition-benchmark-2026-09-15.md) 只作为当时测量证据。
- 真实数据清理、回填或存储迁移需独立授权；过去 QA 数据删除批准不能用于新环境或真实客户资料。

## Independent cost-card storage boundary

This document covers business/dishes/settled_orders/takeaway_orders store-date partitions. Cost cards use an
independent directory and one complete CSV per card; they do not enter these partition/date APIs.
See the [cost-card contract](api-contract.md#cost-cards-published-launcher-separate-service-gate) and
[employee workflow](../../skills/smedc-mcp/references/cost-cards.md).
