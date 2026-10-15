# 成本卡 CSV＋MySQL 目录设计

状态：CSV＋MySQL 目录实现已合并 main；launcher `0.10.0` 已公开发布并独立验证。更新：2026-10-15。发布源：`main@0ce5291`；当前安装 pins 与服务推荐版本为 `0.10.0`，最低兼容 `0.6.0`。服务上线另行推进，不代表部署已完成、真实租户已授权或完成真实数据验收。

本文件是成本卡当前设计与实现合同，与根目录[术语表](../../CONTEXT.md)采用同一架构。公共接口以[API 契约](api-contract.md)为准；已发布的 launcher 不代表服务或租户已就绪。服务上线、正式人工验收与真实数据导入分别核对授权和实际证据。

## 1. 架构与服务边界

用户上传包含一张或多张成本卡的原始 XLSX/CSV。服务完整校验后，按“组织＋企业＋来源＋SPU＋SKU”将每张完整卡保存为一个标准 CSV：

- **OSS CSV 是当前完整业务内容的权威载体**：每卡一个文件，每行一条物品明细，包含标准配方及全部例外。
- **MySQL 成本卡目录是身份、检索、当前指针和生命周期的权威元数据**：保存菜名、SPU、SKU、规格、分类等信息，支持 agent 按业务条件找卡。
- 服务端负责当前权限下的目录检索和 CSV 交付；物品、配方、适用门店、数量条件筛选及分析由 agent 在下载后的本地完成。
- 复用 dishes/business 的 CSV、对象校验、原子指针发布、授权 manifest 和 launcher 下载设施；使用成本卡自身身份及保留原件规则，不套门店/营业日分区键。
- MySQL 只新增一个成本卡目录表，不保存配方、物品或门店明细副本，不新增明细搜索索引或服务端分析引擎。
- 保留历次原始档案和必要批次。当前 CSV 不保留历史版本或 rollback copy；历史追溯使用原件，不提供历史结构化卡查询。
- 成本卡是随新菜品和配方调整而低频更新的小体量资料。复用现有发布、下载和垃圾队列，保留必要原子性与有界失败恢复；不新增下载租约表、持久化下载会话、异步打包服务或独立性能测试体系。
- 本功能不增加员工 AI 界面、报表生成、菜品/物品主档维护、源数据自动修复或跨数据集硬关联。

## 2. 身份、配方与更新单位

业务唯一键：

```text
org_id + enterprise_key + source_namespace + spu_id + sku_id
```

`org_id`由登录身份确定，客户端不可覆盖；`enterprise_key`沿用明确的企业规范化；本版来源空间`source_namespace="meituan"`，同一企业只有一个美团编码空间。未来多个独立后台或其他来源须先定义空间，不能混用。

卡由稳定 CUID `id`标识。SPU＋SKU组合不同就是不同卡，不限制一个SKU只能对应一个SPU，不按SKU单列覆盖，不按同名或相同用料合并。编码保留字符串/前导零。菜名、分类、规格、售价、配方和物品均可变，不参与身份；改SPU或SKU按另一个组合处理，不自动迁移旧卡。

一个组合的完整卡包含标准配方及全部例外；在单次输入内，配方按类型＋名称分组，无独立稳定配方编码。CSV不提供配方/物品数据库ID，不承诺跨上传逐行身份稳定。例外可以与标准有不同物品/数量/成本，同门店可以属于多组例外；忠实保存，不推断替换、附加、互斥或优先级，不生成唯一最终用料。

局部上传指“部分SPU＋SKU的完整卡”，不是卡内明细补丁。某组合新文件只有标准配方时，旧例外从当前卡移除；未上传的其他组合完全不变。不凭文件名、日期、文件修改时间或业务值判断新旧，以最后成功提交为准。

## 3. MySQL 当前目录

一行对应一张卡，归档后仍保留唯一身份，共 **27个字段**：

| 用途         | 字段                       | 含义                         |
| ------------ | -------------------------- | ---------------------------- |
| 身份         | `id`                       | 稳定成本卡主键               |
| 身份         | `org_id`                   | 所属组织                     |
| 身份         | `enterprise_key`           | 规范化企业标识               |
| 身份         | `enterprise_name`          | 企业名称                     |
| 身份         | `source_namespace`         | 来源编码空间                 |
| 身份         | `spu_id`                   | 菜品SPU编码                  |
| 身份         | `sku_id`                   | 菜品SKU编码                  |
| 找卡         | `dish_name`                | 菜品名称                     |
| 找卡         | `specification_name`       | 菜品规格                     |
| 找卡         | `base_category_name`       | 菜品分类                     |
| 找卡         | `sale_price`               | 原表售价                     |
| 来源业务标志 | `has_cost_card`            | 原表“是否配置成本卡”         |
| 来源业务标志 | `source_dish_deleted`      | 原表“菜品是否删除”           |
| 当前CSV      | `object_key`               | 内部不可变对象位置           |
| 当前CSV      | `checksum_sha256`          | 文件确切字节校验和           |
| 当前CSV      | `byte_size`                | 文件字节数                   |
| 当前CSV      | `item_row_count`           | 全部配方的物品明细行数       |
| 当前CSV      | `recipe_count`             | 配方组数                     |
| 当前CSV      | `csv_schema_version`       | CSV格式版本                  |
| 内容比较     | `content_hash`             | 规范化整卡业务指纹           |
| 内容比较     | `canonicalization_version` | 规范化/指纹规则版本          |
| 追溯         | `source_document_id`       | 原始档案                     |
| 追溯         | `import_batch_id`          | 成功导入批次                 |
| 生命周期     | `revision`                 | 当前更新序号                 |
| 生命周期     | `archived_at`              | 单卡归档时间，NULL表示未归档 |
| 生命周期     | `created_at`               | 创建时间                     |
| 生命周期     | `updated_at`               | 目录最后更新时间             |

目录业务字段和CSV来自同次候选并原子发布，不独立编辑。命名与菜品目录对齐，但保留源值，不引入跨表业务外键；售价不表示销售平均价或配方总成本。物品内部解析名称使用`item_code`，不是商户号。

成本卡使用既有BusinessResource的`cost_card` kind、`cost-card:<id>` resourceKey和集团级`cost_cards`类别；权限由现有系统关联，不另建ACL。来源复合外键绑定组织、原件和批次，保证追溯和组织一致性，不继承原件归档状态。

## 4. 上传、校验与CSV格式

### 4.1 输入合同

通过现有 `upload_structured_dataset` / `POST /v1/structured/imports` 增加 `dataset = cost_cards`。接受 XLSX 和具有同样表头的 UTF-8 CSV，必需元数据沿用企业名、幂等键。按当前固定类别机制使用企业配置的成本卡类别密级，上传参数不能另行覆盖；类别或必需权限属性未就绪时不得按默认 0 级发布。此数据集不接受业务日期窗口或快照日期，不根据文件名推断生效日期。

保留源文件。使用现有格式、体积、行数、列数和解析资源限制，不要求客户端预先拆卡或改成 JSON。

XLSX 前十行查找受控表头，跳过表头前标题；合并多个表头完整匹配的可见工作表。工作表识别与表头完整性校验分开：扫描行包含任一已登记的 SPU/SKU 编码列名，或至少两个不同的已登记业务列名时，视为成本卡候选表头（按精确列名/登记别名判断，不做模糊猜测）；候选工作表缺列、重列或含未知列均整份拒绝，不得作为无关页跳过。隐藏的候选工作表同样整份拒绝。只有未识别到候选表头的说明页/无关页可以忽略并记录安全摘要；没有任何有效数据工作表时拒绝。CSV 首行必须是完整表头。不信任 XLSX 声明的使用区域作为唯一行数依据，避免合法数据被错误维度截断。

例如同一卡的标准配方在 Sheet 1、例外配方在 Sheet 2，后者缺列时必须拒绝整个文件，不能只导入标准页并误删旧例外。此规则防止可识别的损坏工作表被静默丢弃，不承诺识别完全移除表头或业务行的人工漏传。

严格识别讨论样本的 35 列：完整表头必须存在，允许字段值按下述规则为空；未知列、重复列、缺失列拒绝，不悄悄丢弃。字段别名只接受代码中明确登记的别名。保留现有解析器的合并单元格支持，不另建一套 Excel 引擎。

用户已确认列结构与空值的区别：已定义业务列允许调整顺序，但缺少整列时整份拒绝，返回缺失列名，不自动补空也不从旧卡补齐。列存在且允许为空的单元格按源空值保存；身份等明确必填字段仍执行对应格式校验。完整替换时，明确传入的空值可以覆盖旧值，缺失整列则不能被解释成主动清空。

### 4.2 按卡归组

扫描全部有效行后先按成本卡业务唯一键归组，再按配方类型 + 名称分组，不要求同一卡/配方的行连续。同一卡的名称、分类、规格、售价、是否配置及来源删除状态必须一致；同一配方内的加工份数、成本、可修改标志、备注及规范化门店集合必须一致。不同配方之间可有不同成本/加工份数/门店，不混成卡头冲突；真实冲突返回工作表、行号和字段。

用户已确认：同一 SPU＋SKU 组合、同一配方内，重复出现的公共字段在按既定类型规范化后确实矛盾，整份文件拒绝，现有业务数据保持原样。错误说明具体字段、该组合及配方，并列出冲突工作表和源行；不得擅自取第一行、最后一行或任意值。同组公共字段一致性不等于物品明细一致性，不同物品的用量、单位和金额不同是正常记录。不同文件按最后成功导入更新，不能将其套用于同一文件内的字段冲突。

编码不转浮点数，保留源文本前导零；名称不做模糊匹配或内部字符改写。纯空白行忽略，部分缺失的物品行按错误处理。

### 4.3 字段和配方校验

用户已确认：明确的字段格式错误使整份上传拒绝，不先写入其他合法 SKU；已有成本卡、配方、明细、归档状态和 revision 保持不变。错误须定位到 SKU、字段、工作表和原始源行，说明预期格式；无法解析为规定数值的文本不能自动置零或忽略。导入任务和错误审计可记录失败状态，“当前数据保持原样”指不改变成本卡目录和当前对象指针；失败候选按任务所有权清理。

拒绝依据必须是明确的格式/存储合同或已确认的身份一致性规则，不能把推测的业务关系当校验条件。未知替换/叠加含义、同门店多组例外、标准与例外物品不同均忠实记录，不据此拒绝导入。

- 必需身份、物品编码、物品名称、单位不得为空。超长值拒绝，不截断后保存。
- 加工份数、物品数量、净料率等只校验约定的数值格式、精度和可空性，不从业务常识另加正值范围约束；0 或其他可表达源值原样保存，不仅因比例高于 100% 就推断错误。
- 数量/金额使用精确十进制字符串解析，百分比转小数；源单元格到规范化、指纹和 CSV 不经过 JavaScript `Number` / `parseFloat`。成本卡 reader 路径须在 `String(Number(raw))` 之前保留 XLSX numeric/受支持公式缓存的原值；其他数据集和日期转换保留原合同。数量/金额按 DECIMAL(20,6)、比例按 DECIMAL(12,6) 校验；超出范围时拒绝，不静默舍入。零值与空值分开保存。
- 百分比文本带 `%` 时精确除以 100：`82%` 与 `0.82` 均存为 `0.82`；无百分号的 `82` 存为 `82`，不得按数值大小猜测缩放。XLSX 百分比样式的底层值 `0.82` 已是比例，不重复除以 100；若 reader 提供显示文本 `82%` 则走文本规则。CSV 使用相同文本规则。两种 reader 表示必须归一到同一指纹。
- 成本、单价、金额及毛利率保留来源数值，不使用当前采购价补齐，不把零成本当成已验证的真实零成本。
- 不用强制等式重算毛料量或消耗金额；源表已经舍入且单位可能不同。没有明确换算规则时，不凭规格文字猜密度、重量或包装换算。
- 同一配方内的重复物品编码按来源行分别保留，不仅因编码重复就猜测是误填而拒绝，不去重、不求和；不同配方同样可以使用同一种物品。
- “是否配置成本卡”按来源字段保存、查询并参与整卡内容比较，不根据“是/否”决定是否接收保存、要求明细为空、清空已有配方、创建特殊“未配置”状态、归档或恢复，也不根据现有样本推断一定会出现“否”。字段的类型映射不赋予其业务执行语义。
- 用量为 0 的物品行保留原数量和单位，不删除、不转为空值，不推断该物品或配方已经停用；其他明确源业务值遵循相同原则。配方和明细只按文件实际记录导入，其增删由已确认的整卡更新规则决定，不由单个状态字段触发。
- 标准配方的适用门店必须为空；例外配方必须有明确门店。门店按源格式分隔，清理首尾空白，规范化去重，保留原始名称和原始门店文本。
- 同一 SPU＋SKU 组合内按来源配方类型/名称分组，保留各组完整明细；同门店可以关联多组例外，不设门店与例外一一对应的约束，不推断互斥关系或优先级。

校验关注可明确验证的结构、字段类型、必填值、身份和同组重复卡头一致性，不把未知业务语义判成错误。`archived_at IS NOT NULL` 的卡不参与普通查询；仅来源标记删除、但未被 SMEDC 单卡归档的记录仍可按字段查询。来源“菜品删除”不触发 SMEDC 逻辑删除或物理删除。

### 4.4 标准CSV

上传使用原始35个业务列，列名/内部字段映射以领域模块的 [`COST_CARD_UPLOAD_SCHEMA`](../../packages/domain/src/cost-cards.ts) 为准。下载格式为这35列加末尾`source_sheet_index`、`source_sheet_name`、`source_row_number`三个源定位列，共38列；它不是35列上传模板，本版通过原始档案重新上传。

- UTF-8无BOM，逗号分隔，RFC 4180引号，LF及末尾换行；固定列序，至少一条有效物品明细。
- 每卡一个完整CSV，卡头/配方公共字段随物品行重复，保留全部业务列和源门店文本，标准与例外分别保留，不合并物品或数量。
- 数字为精确非指数十进制字符串，百分比为比例，布尔true/false，nullable空值为空字段；编码按字符串读取，不让CSV库自动转数值。
- 配方/物品确定性排序，重复次数保留；三个源定位列对应目录指向的原件，不参与业务指纹。内部`readCostCardCsv`按38列schema读取旧卡，不经过35列公开上传校验。
- `checksum_sha256`覆盖文件确切字节；`content_hash`覆盖规范化业务内容。来源行、门店排版等可能改变文件字节，不能据此误判业务更新。
- 全部CSV/schema/规范化规则由服务端确定，launcher只校验和传输，不计算业务指纹或解释配方。

## 5. 去重、原子发布、归档与恢复

### 5.1 业务比较

先按完整身份找卡（包括归档卡），再比较规范化整卡内容，不跨身份去重：

| 当前状态与输入 | 分类与行为                                                            |
| -------------- | --------------------------------------------------------------------- |
| 组合不存在     | inserted：新ID、revision 1、绑定新CSV/来源                            |
| 有效卡内容相同 | unchanged：目录/对象指针/来源/updated_at/revision均不写               |
| 有效卡内容变化 | updated：保留ID，完整切换CSV/目录/来源，revision＋1                   |
| 卡已归档       | restored：保留ID、绑定本次来源、清空归档、revision＋1，内容相同也恢复 |
| 本次未上传     | 不处理，包含未上传的归档卡                                            |

全部35业务列对应值和关系参与比较。1/1.0/1.000等价，null≠0；配方/物品行序和门店顺序不影响，重复物品次数参与；门店按规范化集合比较。名称/单位不做模糊改写或换算。系统ID、上传者、文件名/哈希、批次、源行、时间戳和revision不参与业务指纹。

规范化版本固定，未来变更须显式处理，不能把规则升级误报为内容更新。同一 canonicalization_version 下先比较目录 content_hash：有效卡同 hash 直接判候选 unchanged，不常规下载旧 CSV 或上传无用的新对象；归档卡仍按恢复处理。版本不兼容时明确失败，不猜测等价或现场自动迁移。unchanged保留旧CSV/原件/源行；本次原件与批次仍保存，完整输入登记原件授权，不只按变化卡登记。

### 5.2 对象准备与一次发布

1. API执行当前admin门禁，保存原件/ImportBatch/structured_import任务；worker先校验全部输入，任一格式错误整份拒绝。
2. 锁外分组/规范化/hash，读取目录基线；只为候选新增/变化/恢复卡写CSV、上传并校验byte size/checksum。任务使用不可变run-owned键，不原地覆盖当前键；候选未发布不可公开下载，并登记可恢复清理。
3. 按5.3节只为摘要预算内需要比较的变化卡读取旧CSV。记录全部输入组合的目录存在性及ID/revision/contentHash/objectKey/canonicalizationVersion基线，包括unchanged；预判仅减少准备工作，不决定最终发布。
4. 事务按既有授权publication/worker lease→organizations顺序加锁，锁内重读全部组合和当前权限，核对准备基线。并发变化则回滚，按现有worker有限重试策略锁外重新准备；不增加无界内部重试、逐卡协调器或部分成功。重试耗尽明确失败，保留旧当前数据。
5. 一次事务写入新增/变化/恢复目录、卡资源、原件active/批次applied、计数/摘要和审计，同时撤销已采用对象的候选清理登记、登记被替换对象的延迟清理。全unchanged也applied，但零卡写入。对象/权限/lease/事务任一步失败不切部分指针；提交后worker崩溃不能把当前对象当失败候选删除。
6. 未采用/失败候选进入既有StorageGarbage精确键队列，沿用任务ownership、活跃lease和迟到写入保护。被替换旧CSV从替换时起至少保留24小时，使用队列availableAt持久化，无须逐下载登记；延迟清理只是交付宽限，不开放历史版本查询。共享GC实际执行器删除前检查成本卡当前引用（含归档卡）、活跃任务及到期时间；不得另走绕过检查的直接删除路径。

事务不读写OSS或比较旧CSV，只处理目录/授权/任务元数据；整个原件的变化卡一起提交，不分卡提交。同幂等键同请求返回原批次，同键不同请求冲突；旧成功请求重放不重新发布/恢复，新请求的旧内容仍可覆盖当前不同内容。

### 5.3 限额与发布摘要

输入沿用50MiB、100,000物品行及既有sheet/cell/解压限制；每文件卡数复用`PARTITION_IMPORT_MAX_PARTITIONS`（默认10,000），输出/磁盘/句柄/对象并发复用现有分区设施，不自动扩大到dishes/business的2GiB/500万行。目录批写500条、事务120,000ms，分批执行仍一次提交。

以上是防止误输入耗尽资源的保护上限，不是本功能的吞吐承诺。常规验收使用少量合成卡覆盖新增/未变/更新/恢复及一个并发冲突；超限行为通过调低测试限额验证，不把近100,000行压测、数千对象压力测试或性能指标采集设为实施门禁。有实际慢请求/失败证据时再扩大验证；不因假设高并发增加架构。

ImportBatch.publicationSummary原子保存inputCardCount/inputItemRowCount、inserted/updated/unchanged/restored counts及changes/changesTruncated；四类和等于输入组合数。变化包含卡ID、身份、操作和受控changedFields：目录业务字段、card.created、recipes.added/removed/fields/items/stores、archived_at；这是CSV业务内容摘要，不代表数据库子表。

旧内容比较在锁外，提交摘要必须采用锁内核对过的基线，不能覆盖后重建。先用目录hash完成全部卡分类和精确计数，再按身份稳定排序生成changes，最多100条且JSON UTF-8不超过32KiB。仅预算内需比较字段的updated/restored卡读取旧CSV，新增或仅恢复状态无需读取；同hash的unchanged不读旧CSV。达到条数或字节边界即停止生成后续明细并置changesTruncated=true（最多多读取用于判定字节边界的一张卡），计数不截断。不能为最终丢弃的数千条摘要读取全部旧对象；全unchanged为[]/false。不保存旧/新值、完整配方或链接，不形成历史版本。状态每次按当前源批次内容读取权检查，admin/历史上传身份不豁免，撤权隐藏内容计数和摘要，失败/未提交不报告成功。

### 5.4 单卡归档与上传恢复

`POST /v1/cost-cards/:costCardId/archive` / `archive_cost_card({costCardId})`以明确ID、当前同组织admin及相同发布锁归档整卡；archived_at设当前时间、revision＋1并审计。重复归档幂等，不再改时间/revision。保留目录/当前CSV/来源，不影响同原件其他卡，普通检索/coverage/manifest/下载排除归档卡。

新幂等请求上传同身份完整卡，验证发布成功后恢复原ID/created_at，绑定本次原件/批次、清空归档、revision＋1。内容相同也恢复，生成本次任务的新CSV对象及正确源定位，不重新采用已经退休入队的对象键；原归档卡对象在切换后进入相同24小时延迟清理。失败不部分恢复，旧幂等重放不恢复，未上传卡继续归档。仅原件归档而卡有效，相同内容仍unchanged。

归档与排队上传按实际提交顺序生效；归档不自动取消已接受上传。原件与卡同时归档时，新上传恢复卡和绑定新来源，不恢复旧原件。来源“是否配置/是否删除”和0用量仅为业务值，不触发系统生命周期。归档不是擦除原件，有权读取原件者仍可看到源内容。

## 6. 当前权限与原件追溯

- 上传、更新、恢复、单卡归档采用当前有效同组织admin门禁，不比较历史上传者密级，不要求原上传者，不新增角色/编辑ACL/审批流。
- 普通目录/CSV读取要求当前租户业务授权enabled、企业集团级cost_cards类别grant、当前类别密级及卡未归档。legacy/preparing/suspended不回退旧文件权限；类别未配置拒绝成本卡，不影响既有数据集。
- 已enabled的老租户也须可在现有管理员配置入口补登记cost_cards：管理配置初始化写路径复用initializeFixedBusinessCategories，在当前admin、授权版本锁和审计保护下幂等补缺，UI请求遵守现有CSRF/版本合同；普通查询及GET不隐式写配置。新类别级别为null、无默认grant，不改旧类别或租户模式；补齐后管理员沿用现有配置入口设置密级及授权。部署迁移不批量激活或授权真实租户。
- admin管理不自动授予正文/旧值/CSV或原件下载；后台处理复用主线工作身份和权限切换/lease保护，不新增权限引擎。
- 标准与例外统一集团级授权，适用门店只用于agent本地业务筛选；拥有门店经营/销售/目录权限不自动拥有成本卡权限。
- 原件和卡资源独立有效：目录来源外键不继承Document active门禁，原件归档不影响有效卡检索/下载。原件读取仍检查自身状态和当前类别授权。
- 原件授权按本次完整实际输入登记，不因卡更新、归档或不再引用而收窄；单卡归档不降低原件密级或改其归属。批次证明那次成功导入，不用原件展示状态推导当前卡状态。

## 7. 目录检索与CSV交付

### 7.1 找卡

discovery和`query_structured_dataset(dataset="cost_cards")`仅公开目录标量字段，默认卡ID、企业、SPU/SKU、菜名、规格、分类、售价、revision、来源及CSV行数/大小/schema版本；内部objectKey/contentHash不作为公开字段。

按登记能力select/filter/sort：名称eq/contains/starts_with，编码eq/in，规格/分类/售价/来源标志等常规目录条件。参数化SQL，LIKE通配符按字面转义，不做同义词、语义或模糊身份推断。查询“滩羊肉锅”时先限权，再返回候选及SPU/SKU/规格；同名多规格不任取，不把菜名当唯一身份。

沿用defaultLimit=50/maxRows=200、稳定排序、绑定查询/权限范围的游标，每页重新授权。只允许目录detail模式，不提供明细条件或聚合。coverage来自当前获准目录及来源，不用批次输入行数或原件active代替。售价筛选/返回为精确十进制字符串或null，拒绝JSON number；revision字符串、计数安全整数，旧数据集合同不变。

### 7.2 Manifest与下载

`POST /v1/cost-cards/manifest`与MCP `download_cost_cards`采用共享选择器：

```ts
type CostCardSelection = {
  enterpriseName?: string;
  costCardIds?: string[];
  spuIds?: string[];
  skuIds?: string[];
  dishName?: string;
  dishNameContains?: string;
  specificationName?: string;
  baseCategoryName?: string;
};
```

字段AND、数组内OR，非空ID/编码数组沿用maxInValues=100；省略条件表示当前获准范围。可按目录条件批量下载，或先检索再用ID下载；不接受日期或门店权限选择器。

同次DB授权/状态读取固定目录ID、revision、身份、schema、行数/字节/checksum、sourceDocumentId、importBatchId及不可变指针，再在事务外签发短期链接。来源两个ID按每张卡固定，不能给整个批量下载共用一个来源；它们使CSV的sheet/row定位可追溯，但不授予原件访问权。显式ID必须全部获准且有效，否则整次拒绝，不静默漏卡；条件筛选仅交付当前获准集合，零卡明确空结果，不推断隐藏卡。manifest 字段以[领域共享类型](../../packages/domain/src/cost-cards.ts)与[API 契约](api-contract.md)为准。

下载保护采用小体量场景的简单宽限方案：成本卡URL TTL取现有partitionManifestUrlTtlSeconds与900秒的较小值；旧CSV替换后24小时才可清理，不新增下载租约/会话表。签名完成后，以新的短DB读取重新核对已选卡的当前权限、有效状态、revision/来源/指针，不能沿用第一次读取的旧快照；发生变化则丢弃整份manifest并返回可重试的“成本卡已变化，请重新下载”，不交付混合清单。该次操作沿用有限请求超时，不在服务端循环刷新；签发过程中耗尽URL剩余有效期时也不返回失效链接。manifest.expiresAt不得晚于其中最早URL的实际失效时间。共享GC的引用检查与24小时宽限保护正常在途下载；此要求是新增成本卡接线，不假定现有dishes/business已具备。

交付数量复用默认10,000卡上限及现有传输资源限制；超限要求缩小范围，不截前N卡。复用range下载，本版不新增异步ZIP服务。目录查询与下载两次请求，下载重新授权并交付manifest固定的当前revision；更新后可返回新revision，不冒充先前查询版本，不保证跨页/请求历史快照。

launcher消费内部manifest/短期链接，在新临时目录按稳定卡ID命名CSV，核验安全路径、卡身份/schema/byteSize/checksum/完整数量，保存去链接的manifest.json（逐卡保留revision、sourceDocumentId、importBatchId）；只向agent返回本地目录和安全摘要，不把正文/base64/内部链接放入模型上下文。同名不同规格不覆盖，失败/取消清理部分输出，不报半份成功；agent使用后finally清理。

沿用现有partition-transfer的整批恢复方式：可重试链接失效最多重新领取一次manifest；领取前清理本轮全部已下载输出，再按新清单从头下载，不能保留旧A只补新B。最终文件与manifest必须全部来自最后一次成功的清单；第二次失败或权限拒绝就结束并清理，不无限重试、不恢复旧权限，不新增按卡续传状态。链接按期限失效，不承诺已发链接即时撤回，领取新链接始终重新授权。

### 7.3 本地分析与配套边界

agent在CSV中按物品/配方/门店/数量筛选和统计，保留重复次数与单位，不擅自混单位相加或把多套配方成本合成整卡/最终门店成本。与销售的候选名称关联留在分析Skill：优先matched_product_name，无匹配再product_name；多个候选保留歧义，不写硬映射。

MCP/API/launcher bundled contracts及双份smedc-mcp、受影响companion/manual/cleanup Skills须同步。launcher独立发布验证后才能更新推荐版本和Skill pins；当前新合同不可当作已上线调用。服务本身不执行Skill或生成报告。

## 8. MySQL目录DDL

只新增CostCard目录及ImportDataset.cost_cards、ImportBatch.publicationSummary、BusinessResourceKind.cost_card；既有对象垃圾队列/来源/权限设施复用。实现已包含 [Prisma migration](../../packages/db/prisma/migrations/20261014080000_cost_cards/migration.sql)，并通过真实本地 MySQL 的目录发布、权限、并发和垃圾回收回归；下列 DDL 说明该边界，实际结构以迁移与 [schema](../../packages/db/prisma/schema.prisma) 为准：

```sql
ALTER TABLE import_batches
  MODIFY COLUMN dataset ENUM(
    'dishes', 'business', 'vip', 'dish_catalog',
    'delivery_ledger', 'supplier_catalog', 'cost_cards'
  ) NOT NULL,
  ADD COLUMN publication_summary JSON NULL,
  ADD UNIQUE KEY uq_import_batches_org_id_document
    (org_id, id, source_document_id);

CREATE TABLE cost_cards (
  id VARCHAR(32) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  enterprise_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  enterprise_name VARCHAR(255) NOT NULL,
  source_namespace VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  spu_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  sku_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  dish_name VARCHAR(512) NOT NULL,
  base_category_name VARCHAR(255) NULL,
  specification_name VARCHAR(255) NULL,
  sale_price DECIMAL(20,6) NULL,
  has_cost_card BOOLEAN NOT NULL,
  source_dish_deleted BOOLEAN NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canonicalization_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  csv_schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  byte_size BIGINT UNSIGNED NOT NULL,
  item_row_count BIGINT UNSIGNED NOT NULL,
  recipe_count INT UNSIGNED NOT NULL,
  source_document_id VARCHAR(32) NOT NULL,
  import_batch_id VARCHAR(32) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cost_cards_identity
    (org_id, enterprise_key, source_namespace, spu_id, sku_id),
  UNIQUE KEY uq_cost_cards_object (object_key),
  KEY idx_cost_cards_name (org_id, enterprise_key, dish_name),
  KEY idx_cost_cards_sku (org_id, enterprise_key, source_namespace, sku_id),
  KEY idx_cost_cards_source (org_id, source_document_id),
  KEY idx_cost_cards_batch_source (org_id, import_batch_id, source_document_id),
  CONSTRAINT fk_cost_cards_source FOREIGN KEY (org_id, source_document_id)
    REFERENCES documents (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cost_cards_batch_source
    FOREIGN KEY (org_id, import_batch_id, source_document_id)
    REFERENCES import_batches (org_id, id, source_document_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

组合身份使用精确二进制语义；应用先规范化企业。名称contains不保证B-tree索引命中，本版不为假设规模新增搜索引擎。授权inventory/read-adapter按cost_card资源处理，不套门店/日期权限规则。

## 9. 验收与执行边界

本地合成验证范围：35列原件/38列CSV及精度；逐卡去重、原子指针发布、有界并发重试和对象清理；菜名/SPU/SKU目录检索/同名候选；当前权限、manifest来源及版本一致性、过期后整批重下；原件独立、单卡归档/新请求恢复/旧幂等不恢复；enabled老租户补类别和有界摘要读取。时钟可控的小样本覆盖24小时延迟GC、提交后崩溃和签名期间更新；不等待真实24小时，不增加独立容量/高并发验收。明细查询/分析在agent本地验证。

采用CSV权威内容＋可检索目录的代价是每卡一个对象，跨卡明细分析先下载后本地执行；数据库只处理目录和发布元数据。本次增加目录 schema 迁移；无需迁移或兼容旧成本卡业务明细表，也未导入真实企业成本卡。

服务、launcher 与配套 Skills 已经审阅并合并；launcher `0.10.0` 的 registry 内容、空目录安装、生产依赖审计与 stdio 工具初始化已独立验证。推荐版本与双份 Skill pins 通过发布后同步批次更新至 `0.10.0`。staging 上线由控制器继续核对，正式人工验收、租户授权与真实数据导入分别授权；发布不替代这些证据。

## 10. 设计依据

- [项目实施边界](implementation-plan.md)
- [dishes/business当前分区契约](structured-partitions.md)
- [OSS当前分区架构依据](../adr/0026-business-dishes-current-oss-partitions.md)
- [当前API合同](api-contract.md)
- [业务权限与原件权限设计](business-related-authorization-design.md)
- [结构化导入生命周期](../adr/0019-structured-import-lifecycle.md)
- [现有数据库模型](../../packages/db/prisma/schema.prisma)
