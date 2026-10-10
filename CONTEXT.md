# SMEDC (企业资料中枢)

> ADR 0026 defines the merged implementation for `business` / `dishes`; staging remains row-based
> until the linked hard migration is deployed and accepted.

A remote business-document service that employees use through their own AI agents. This context
covers the language for employee authentication, supported agent forms, and session ownership.

## Language

**Employee Account**:
The backend authorization subject (员工账号) that owns organization scope, functional role,
confidentiality clearance, disabled state, and audit attribution.
_Avoid_: account meaning a token, device, or agent installation.

**Functional Role**:
An Employee Account's developer-provisioned `admin` or `employee` identity that gates
administrative functions when such functions exist but does not grant access to a higher document
confidentiality level.
_Avoid_: a default role, `manager`, document-access role, confidentiality clearance.

**Confidentiality Clearance**:
The maximum level from 0 through 3 that an Employee Account may read.
_Avoid_: employee label, store scope, job title.

**Clearance Provisioning**:
The developer-operated, mandatory creation-time assignment of an Employee Account's
Confidentiality Clearance from 0 through 3; no in-product clearance-change function exists.
_Avoid_: a default clearance, admin self-service, employee self-service, automatic role-based
clearance.

**Document Confidentiality Level**:
The mandatory ordinal classification from 0 through 3 attached to every document that determines
the minimum Confidentiality Clearance required to read the document and its derived data.
_Avoid_: store tag, personal tag, business category.

**Document Classification**:
The admin uploader's explicit selection of a Document Confidentiality Level, defaulting to 0 when
no level is explicitly supplied.
_Avoid_: AI inference from a filename, document content, uploader, or business context.

**File Upload Capability**:
The privileged ability of an active admin Employee Account to introduce a new file into the
service, regardless of document kind, dataset, file format, or upload transport.
_Avoid_: a capability of the employee role, a file-type-specific exception, client-side hiding,
service-to-service ingestion authority.

**Immutable Document Classification**:
The rule that a document's Confidentiality Level is fixed after upload; no in-product
reclassification function exists.
_Avoid_: uploader edits, admin correction, automatic retrospective classification.

**Privileged Administrative Operation**:
An explicitly admin-gated service function that every admin may use at any Confidentiality Level,
including any information access the function itself defines.
_Avoid_: a secondary clearance check, a non-privileged admin-only function, a blanket bypass for
unrelated ordinary reads.

**Organization Boundary**:
The mandatory condition that an Employee Account and a document belong to the same organization
before Document Confidentiality Level is evaluated.
_Avoid_: a confidentiality level as cross-organization access authority.

**Disabled Employee Account**:
An Employee Account retained for history and possible future re-enablement but granted no
employee-facing capability while disabled.
_Avoid_: a partially active account, a deleted audit identity.

**Ordinary Document Read**:
Any employee-facing retrieval, search, download, status, metadata, row, aggregate, or error result
whose entire result set is constrained by Organization Boundary and Confidentiality Clearance.
_Avoid_: content-only access control, a metadata or aggregate bypass.

**Derived Document Data**:
Any index, chunk, structured row, aggregate, metadata view, or download capability produced from a
source document that inherits the source document's Document Confidentiality Level.
_Avoid_: an independently classified row, chunk, vector payload, or derived-data downgrade.

**Current Structured Partition**:
The authoritative canonical CSV for one organization, normalized enterprise, `business` or
`dishes` dataset, store identity, and complete business date. It has its own current
Confidentiality Level from the upload that published it and is not derived from a retained source
document.
_Avoid_: a MySQL detail-row batch, an immutable source document, a historical partition version.

**Partition Manifest**:
An authorization-filtered, short-lived inventory of readable Current Structured Partitions and
their presigned download links. The launcher consumes the links and returns verified local files;
the employee-owned agent does not receive the links.
_Avoid_: a row-query response, a permanent download URL, an OSS directory listing.

**New Upload**:
A file supplied to the service as a new document, even if an employee or agent created it outside
the service using other material; it receives only its explicitly supplied or default Document
Confidentiality Level.
_Avoid_: automatic source-lineage inference, cross-document information-flow enforcement.

**Login Identity**:
The verifier-owned credential identity bound to exactly one Employee Account.
_Avoid_: account, employee.

**Employee-owned agent**:
The general-purpose AI agent the employee talks to; it drives installation and use through the
SMEDC MCP skill and must never see credentials.
_Avoid_: just "agent" when the speaker means the MCP host or the launcher.

**MCP client / host**:
The process environment that starts the launcher and exposes its tools to the agent.
_Avoid_: agent, launcher.

**Launcher**:
The stdio MCP adapter that owns protocol credentials and attaches them to remote requests; it never
exposes tokens or passwords to the agent/model.

**Employee channel**:
The surface through which the employee receives the login link from the agent (chat, phone remote
control, desktop UI).

**Agent instance**:
The launcher-bound, employee-visible identity of a login requester, shown on the verification page
and mirrored in the employee channel so the employee can confirm who receives the session.

**Verification page**:
The first-party SMEDC page where the employee enters email/password and confirms the
Agent instance before the login completes.

**Secure store**:
The macOS Keychain or Windows Credential Manager record that holds the durable credential; absent
on headless hosts.

**Memory-only session**:
The no-durable-credential mode used when no Secure store exists; the session ends when the
launcher process exits and the employee taps the login link again.

**收货单据号 (Receipt ID)**:
收货单上的业务编号，是台账与配套检疫证明之间由业务人员识别、经统一规范化后匹配的关联键。
_Avoid_: 售后单据号、Source document ID.

**源文档 ID (Source document ID)**:
企业资料中枢为每个已上传原文件分配的系统标识，用于定位受权限保护的原文件。
_Avoid_: 收货单据号、文件名、对象存储键.

**源文件下载链接 (Source File Download Link)**:
员工通过后端授权后获得的、不暴露存储供应商契约且自签发起 24 小时有效的临时文件访问地址。
_Avoid_: 永久链接、公开链接、Source document ID.

**检疫证明 (Quarantine Certificate)**:
与 evidence、structured 平行的第三类企业资料，以 JPG 或 PNG 原文件保存并按收货单据号关联收货业务。
_Avoid_: 通用图片资料、台账行附件.

**Support class A**:
Interactive desktop agent on macOS/Windows with a local system browser.

**Support class B**:
Phone-remote-controlled agent running on the employee's own PC.

**Support class C**:
Headless remote agent on a VPS/cloud host with no local browser or OS credential store.

**Support class D**:
Fully unattended agent with no interactive login; out of scope for login flows.

## Relationships

- An **Employee Account** is the authorization subject; a **Login Identity** binds to exactly one
  **Employee Account**.
- An **employee-owned agent** runs on an **MCP client / host**, which starts the **launcher**.
- The **launcher** authenticates on behalf of the **Employee Account** and never reveals
  credentials to the agent.
- The employee completes login through the **employee channel** on any device that can open a web
  page.
- Employees use quarantine-certificate and source-file capabilities through the official
  MCP/launcher. HTTP remains the service contract; MCP is a thin authenticated adapter.
- Public receipt business keys are `receiptId` in JSON/API/MCP and `receipt_id` in structured
  query rows. Do not add `receiptNumber`, `receipt_number`, or `RECEIPT_NUMBER_*` compatibility.
- A receipt ID may have zero, one, or many quarantine certificates. Each certificate links to at
  most one receipt ID and may be uploaded before the corresponding delivery ledger exists.
- Quarantine certificates have their own Document Confidentiality Level and do not inherit one from
  a delivery ledger with the same receipt ID.
- An Employee Account has exactly one Functional Role and one Confidentiality Clearance.
- A developer must explicitly provide both Functional Role and Confidentiality Clearance when
  creating an Employee Account; neither has a default value.
- A Disabled Employee Account cannot read, upload, or perform a Privileged Administrative
  Operation, regardless of its Functional Role, Confidentiality Clearance, or existing session.
- Only an active admin Employee Account has **File Upload Capability**; an employee Employee
  Account cannot start or continue a New Upload through any employee-facing transport.
- File Upload Capability governs Employee Accounts only; any future scheduled connector, external
  integration, or service account requires a separately designed service identity and
  authorization model rather than an admin Employee Account.
- An admin Employee Account performs Document Classification while uploading; an employee-owned
  agent must use level 0 unless the admin explicitly supplies a different level.
- File Upload Capability and Document Classification are independent of the admin uploader's
  Confidentiality Clearance; an admin may upload at a higher level than the admin can ordinarily
  read.
- Every document kind uses the same mandatory Document Confidentiality Level; there are no
  kind-specific classification exceptions.
- An active Employee Account can read a same-organization document only when its Confidentiality
  Clearance is at least the document's Document Confidentiality Level; Functional Role does not
  alter this rule.
- Employee labels, document labels, label catalogs, and label-based access rules do not exist;
  legacy label data has no compatibility semantics and may be discarded during implementation.
- Ordinary Document Read does not expose a document or its derived data when the Employee Account
  lacks the required Confidentiality Clearance, including through metadata or aggregation.
- Every employee-facing function that checks for the admin Functional Role is a Privileged
  Administrative Operation; within that function's declared scope, admin access is independent of
  Document Confidentiality Level.
- A Privileged Administrative Operation does not change Confidentiality Clearance checks for
  unrelated Ordinary Document Reads.
- Organization Boundary is evaluated before Confidentiality Clearance; no Employee Account can use
  its clearance to read a document in another organization.
- Every Derived Document Data item inherits its source document's Document Confidentiality Level;
  there is no independent row-level, chunk-level, or index-level classification.
- `business` and `dishes` are the explicit exception to source-document-derived storage: their
  temporary source upload is deleted after terminal processing, and each Current Structured
  Partition carries the classification declared by the upload that most recently published it.
- A newer successful upload may replace a Current Structured Partition's bytes and Confidentiality
  Level, including with a lower level. Only the current partition exists; no previous partition
  version or rollback pointer is retained.
- Current Structured Partition identity is scoped by organization, normalized enterprise, dataset,
  store identity, and business date. Merchant ID is preferred; normalized store name is the
  fallback when the source has no merchant ID.
- Partition Manifest authorization is applied before counts, metadata, or links are produced.
  Hidden partitions are indistinguishable from absent partitions.
- A New Upload is a separately classified document. The service does not infer, record, or enforce
  its relationship to material that an employee or agent previously read outside the service.
- Every row-query structured detail row can expose selectable-only `source_document_id`.
  `business` and `dishes` expose no detail rows or retained source-document download; they are read
  through Partition Manifests and launcher-local verified extracts.

## Example dialogue

> **Dev:** "Support class C has no browser on the host — can the launcher still show the login
> link?"
> **Domain expert:** "Yes. The launcher returns the first-party link, the agent surfaces it through
> the employee channel, and the employee opens it on the phone."

## Flagged ambiguities

- "agent" was used to mean the AI agent, the MCP host, and the launcher — resolved: these are three
  distinct concepts.
- "支持某种 agent" conflated protocol-level compatibility with product-level support — resolved:
  product support requires an employee channel, a runnable launcher, and credential storage on the
  host.
- "账号" must never mean a token, device, or agent installation; it always means the
  **Employee Account**.

## Business-related access model — target design, implementation pending

The following captures the reviewed target as of 2026-10-10, not implemented behavior.
The authoritative target specification is
[business-related-authorization-design.md](docs/implementation/business-related-authorization-design.md);
the existing model above and ADR 0025 still describe the current runtime until implementation.

### Language

**业务强相关权限模型**:
以信息类别、业务归属等业务属性和保密等级共同决定员工信息读取范围的目标授权模型。
_Avoid_: 仅凭功能角色授权、仅凭密级授权、上传者自动获得读取权。

**信息类别**:
需要独立维护和分配访问权限的业务信息分类，例如经营数据、供应商名单、培训材料或第三方财务报告。
_Avoid_: 文件格式、物理数据库表、功能角色、evidence 处理方式。

**evidence 处理方式**:
将文档解析为可检索证据片段的资料处理方式，本身不赋予文档特定的信息类别、归属或密级。
_Avoid_: evidence 统一读取权限、所有文档共用的业务类别。

**业务维度**:
描述信息业务属性并参与访问范围匹配的维度，例如门店，以及未来按业务需要定义的其他维度。
_Avoid_: 密级、上传者身份、仅供查询使用的筛选条件。

**归属范围**:
明确区分集团级、门店等业务归属语义的授权属性，其值不决定其他业务维度是否存在。
_Avoid_: 省略门店即集团级、集团级即全部门店、集团级即没有其他维度。

**集团级信息**:
在本企业内以集团为归属而不按门店划分、但仍可受其他适用业务维度限制的信息。
_Avoid_: 跨企业共享信息、门店信息的通配范围、不受其他业务条件限制的信息。

**evidence 整份归属**:
一份 evidence 文件及其全部检索片段、索引等直接衍生内容共同继承上传时声明的完整业务归属。
_Avoid_: 按片段重新判断门店、共有文件任一门店获权即可读取、切块后放宽源文件权限。

**结构化原文件权限继承**:
上传文件经处理得到的结构化数据，其业务逻辑确定的权限限制自动共同约束整份原文件；未识别内容随原文件管理。
_Avoid_: 未识别内容另行定权、管理员再次声明原件范围、只满足部分已解析数据权限即可下载整个原件。

**台账 PDF（目标授权定义）**:
由系统组合台账、供应商信息和检疫证明生成、面向员工交付并独立设置业务授权及类别密级的信息类别。
_Avoid_: 必须拥有全部上游类别权限才能读取的源文件集合、自动继承上游最高密级、evidence 切块、原始台账下载。

**类别统一密级**:
由本企业 admin 配置和修改、统一约束该企业某一结构化信息类别或台账 PDF 类别全部新旧数据的当前密级。
_Avoid_: 跨企业统一密级、不同导入批次分别定密、逐行定密、evidence 文件密级。

**权限名片**:
由账号统一保密等级和多条业务授权组成的员工信息读取权限画像。
_Avoid_: 上传能力、登录凭证、将所有授权范围合并后任意组合的扁平权限列表。

**业务授权**:
将一个或多个信息类别与一组业务范围绑定的完整读取授权条目。
_Avoid_: 信息类别与业务范围分开授予后跨条拼接、账号密级的局部覆盖。

**企业权限管理员（admin，目标定义）**:
受企业信任、可以查看本企业包括自己在内所有账号的权限配置，分配业务授权并修改账号保密等级的功能角色。
_Avoid_: 只能转授自己现有读取权限的管理员、跨企业权限管理员。

### Relationships

- 文件上传及其触发的正常衍生处理仍以有效 admin 发起的授权上传为入口，普通读取不因上传者身份而获权。
- 信息读取要求匹配信息类别及适用业务维度，并满足员工保密等级不低于信息密级。
- 一张权限名片可以包含多条业务授权；每条可以列出多个信息类别，并将这些类别共同绑定到该条的业务范围。
- 多条业务授权按可读范围取并集；每个被授权业务范围项必须完整满足至少一条授权，不能跨条拼接该项的信息类别与业务维度条件；同一文件的不同范围项可以分别由不同完整授权覆盖。
- 同一信息类别可出现在多条业务授权中，例如菜品数据分别获准访问 A/B、C/D 和 E/F/G 门店。
- 保密等级暂时仍由账号统一持有，不在各条业务授权中分别设置。
- admin 可以在本企业内向任何账号（包括自己）授予其目前没有的业务权限，不受管理员自身现有业务读取范围限制。
- admin 可以查看本企业全部账号的完整权限配置，包括自己、其他管理员和普通员工的业务授权及密级；查看权限配置不等于读取这些账号可见的业务正文。
- admin 可以修改本企业内所有账号（包括自己及其他 admin）的账号保密等级，取代现行仅由开发/DevOps 配置的限制。
- admin 被定位为企业 IT 主管、FDE、总经理等受信任的权限管理者；账号创建时若为 admin，保密等级默认最高，此默认只描述创建瞬间，不是持续强制规则。
- 新 admin 没有隐式业务授权；开发者创建账号时可以显式配置初始业务授权并留痕，未指定才为空，不要求先创建空账号再登录自授。
- admin 可以显式降低自身账号保密等级，普通读取随之受限，但权限管理权保留，因而可以再次将自身等级调回最高；系统不应因其 admin 身份自动恢复最高等级。
- 管理员业务授权变更须审计操作者、被操作账号及变更内容；账号密级变更沿用同一审计原则。
- evidence 按单份文件或单条资料定密；结构化信息按整类业务数据统一定密，不按供应商等记录分别定密。
- 结构化信息类别和台账 PDF 的类别统一密级由本企业 admin 配置和修改，各企业互不影响；开发维护类别接入不意味着由开发固定所有企业的密级。
- 类别密级修改后，后续读取按当前配置统一检查已有及新产生的数据，不保留按旧导入批次分别生效的历史密级；业务授权条件仍须满足。
- 类别统一定密不适用于 evidence；evidence 保留每份文件独立的密级。
- admin 上传 evidence 时明确指定业务信息类别、归属及文件密级；例如集团级一级培训材料，或 C 门店三级第三方财务报告，均使用同一 evidence 处理方式。
- evidence 信息类别目录由本企业 admin 显式创建和维护，上传时选择已存在的类别；自由输入名称不能在上传过程中隐式创建类别。
- 结构化信息类别的新增由开发接入和维护，admin 不能自行创建结构化信息类别；为员工授予已有类别的访问权限仍属 admin 职责。
- 新建 evidence 业务类别不意味着新增解析能力；新结构化类别须具备相应的数据处理及权限定义后才能接入。
- evidence 的业务维度可由本企业 admin 显式创建、维护取值并配置到相应类别；文档归属与员工授权共同引用这些定义。
- 结构化类别新增业务维度须由开发接入，明确属性来源及整类/逐记录作用范围；admin 可以提出需求并与开发共同设计，不能仅凭新增一个维度名称就让已有结构化数据自动按该维度授权。
- evidence 与结构化类别使用同一业务维度时应共用其定义和取值目录，避免同名但含义不一致的授权属性。
- 当前实现没有贯穿所有业务、必填的统一门店 ID；部分数据的商户号不等于全系统门店主键。目标业务权限按本企业内的门店名称精确识别，不同名称视为不同门店，不做相似度检查、模糊匹配或自动别名合并。
- 给现有类别新增必需业务维度时，旧资料和旧授权必须明确补齐；缺失维度不能解释为全范围或自动忽略。
- 必需维度变更允许先准备、补齐再启用；启用后仍缺少必需属性的资料或授权不放行。
- evidence 的全部片段继承源文件的信息类别、完整业务归属及密级，不因解析或切块获得独立的权限属性。
- 本企业 admin 可以在上传后修改 evidence 整份文件的信息类别、业务归属及密级，无需重新上传内容；既可纠正错误，也可主动调整可读范围，普通员工无此修改权。
- evidence 权限属性修改统一作用于源文件及其全部片段；后续读取按当前属性授权，旧索引或缓存不得继续使用旧权限放行；保留操作者及修改前后属性的审计记录。
- 业务授权、账号等级或资料权限属性变更后，新请求立即按当前权限检查，不依赖用户重新登录。
- 已签发下载链接保留原有有效期，不要求因权限收回而立即失效，也不新增缩短期限或加速失效机制；例如普通源文件链接仍可自签发起使用 24 小时，即使持有人期间失去对应权限。
- 新请求鉴权规则不追溯撤回已签发链接的既有下载能力；不能把源文件链接仍有效误报为新权限尚未生效。
- 业务维度可能作用于整类信息或其中的单条记录；供应商名单等集团级信息可以不适用门店维度。
- 会员数据明确属于本企业集团级信息，不按储值门店或开卡门店限制读取。员工须获授会员数据的集团级权限并满足该类别密级，之后可读取本企业全部会员数据；门店字段仍可用于查询筛选，但不作为授权条件。会员数据原文件自动继承同一集团级规则。
- 集团级信息须显式获得匹配的信息类别和“归属范围：集团级”授权，不能通过忽略门店授权条目中不适用的条件而间接获权。
- 集团级授权可以同时包含其他业务维度及其允许值；集团级只明确归属，不免除其他适用维度的匹配要求。
- 多个信息类别只有在共同适用该条业务范围及维度条件时才能合并到同一授权条目；不得为不适用的类别静默忽略条件。
- 应有门店归属却缺失门店属性的数据不能自动视为集团级信息；不适用某维度与缺失必要维度是不同状态。
- 新增信息类别时必须明确其权限维度及分配方式，不能仅因接入数据就默认对员工开放。
- 可拆分的结构化数据按获准范围查询、聚合和导出，聚合只计算获准数据；没有完整源文件下载权不妨碍读取其中已获准的结构化数据。
- 结构化原文件自动继承该文件成功解析出的全部数据权限要求，包括信息类别、门店等业务范围及适用密级，不限于门店；员工必须同时满足这些要求才能下载整份文件，不只检查其当前可见的数据子集。
- 结构化原文件不另设一套人工维护的业务范围或密级；类别当前密级和其他适用权限条件变化时，原文件随之检查新条件，不能继续沿用上传时独立设置的旧密级。此规则涵盖门店数据、集团级目录和其他已接入的结构化类别。
- 只解析出属于 A 的结构化数据、其他部分未识别时，整份原文件连同未识别内容都按 A 的权限读取；满足 A 全部读取条件即可读取 A 的结构化数据及完整原文件。未识别部分不额外定权，不要求管理员确认整份文件范围。
- 分别解析出属于 A、B 的结构化数据时，下载原文件必须同时满足 A 和 B 的当前权限要求；只有 A 权限仍可读取 A 的结构化数据，但不能下载整份原文件。原文件不冻结导入时旧权限，随衍生数据的当前权限规则检查。
- 原文件继承规则适用于实际保留的原文件，不改变现有数据保存方式；经营/菜品销售现行仅保留标准化分区，本次权限设计不新增已删除来源 Excel 的留存或下载功能。
- 用户可在产品外向 admin 说明读取需求，由 admin 决定是否新增正常业务授权；获授对应类别的 B/C 范围后可与已有 A 范围共同覆盖完整文件，不引入一次性下载绕过。
- 新增业务授权适用于其范围内的同类信息，不仅限于引发授权需求的那份源文件；产品内申请审批流程尚未在本次设计中定义。
- evidence 以整份文件为不可拆分的读取单位；声明归属 B/C 时，完整文件及每个检索片段均要求同时覆盖 B 和 C，不能因为片段内容只提到其中一家就放宽授权。
- 需要 B 独有、C 独有和 B/C 共有三种读取范围时，admin 应分别上传三份相应文件；服务不在同一 evidence 文件内部为片段分别定归属。
- 台账 PDF 是独立授权的正式交付类别；员工读取时按其类别与业务范围授权，不要求同时拥有上游原始台账、供应商名单及检疫证明类别的业务读取权。
- 检疫证明是开发维护的固定类别；每张检疫照片、每份台账 PDF 必须且只能归属一家门店。不得将 evidence 的多门店共有规则扩展到这两类资料；照片与其关联台账、PDF 必须属于同一门店。
- 获授台账 PDF 不反向授予上游类别的独立查询或下载权；原始台账主要作为内部生成输入。
- 检疫证明与台账 PDF“各自独立”指类别读取权可分别授予：可看 A 店成品 PDF（含其中已排入的照片），不等于可单独读取检疫照片原件；反向同样不互授。两者生成关系仍保留。
- 仅修改检疫照片的读取授权或密级，不改变相关旧 PDF 的业务授权、门店范围或密级，也不因此使 PDF 失效或重新生成；PDF 始终按其自身当前权限读取。
- 检疫照片内容修正、替换、撤下或归档后，受影响的旧台账 PDF 随之失效，系统不再提供旧版下载；每日 PDF 巡检自动按最新有效照片重新生成，撤下的照片不再纳入，替换的使用当前有效照片，新版成功就绪后可下载。失效和重生成不意味着继承照片权限；已签发链接继续按原有效期使用。
- 对员工只开放台账 PDF 交付，取消现有按门店/日期提供的原台账记录数、单据去重计数及采购金额合计等汇总查询；不采用 PDF 与汇总共用对外类别的方案。
- 台账原始明细、原文件及汇总不再作为员工读取入口；PDF 查找、覆盖状态、下载准备和任务状态是 PDF 交付的配套能力，不能借此重新开放原台账查询。
- 台账 PDF 按其独立信息类别统一定密，可低于上游资料密级，不自动继承上游最高密级；员工达到 PDF 类别密级并满足其业务授权即可读取。
- 台账 PDF 的独立业务授权和定密是该正式产物的明确设计，不能推导为所有切块、普通导出或任意包装均可脱离来源权限；evidence 片段与普通数据导出仍遵守已确定的继承及范围规则。
- 员工可查看本人的权限名片。拒绝读取时可明确显示受限资料的名称、概述或用于说明原因的汇总信息，不要求一概隐藏存在性或统一成模糊错误；正文、业务明细及下载仍须按权限交付。

### Example dialogue

> **Dev:** “同为三级账号，负责 A、B、C 门店的经理能读取 D 门店经营数据吗？”
> **Domain expert:** “不能；达到密级只是条件之一，还必须满足业务范围和信息类别授权。”

> **Dev:** “两份文件都进入 evidence 流程，是否因此属于同一种读取权限？”
> **Domain expert:** “不；集团级一级培训材料与 C 门店三级第三方财务报告分别按自己的业务类别、归属和密级授权。”

### Flagged ambiguities

- ADR 0025 排除门店权限，且现行结构化行/分区继承上传密级；本次目标明确要求重新设计这些规则，尚未宣告迁移完成。
- 权限名片采用多条业务授权，每条绑定一个或多个信息类别与业务范围，已明确；不能将各条范围拍平后形成额外组合。
- admin 的本企业全范围授权、自我授权及所有账号密级修改权已明确；不能将 admin 当前较窄的读取权限视为对其最终可获得权限的强制限制。
- admin 最高密级已明确为账号创建时的默认设置，允许之后显式降低和恢复；此决定不定义既有账号角色变更时的密级处理。
- 新请求立即使用当前权限、已签发链接按原有效期继续有效且不加速失效，已明确；本次不采用 5 分钟短链接窗口方案。
- evidence 是处理方式而非业务信息类别，且其类别由 admin 显式创建、结构化类别由开发维护，已明确；类别与结构化数据集的对应关系见 Q36 及正式设计。
- 类别统一密级由本企业 admin 管理且统一作用于新旧数据，已明确；evidence 上传后允许本企业 admin 修改类别、归属和文件密级，取代现行不可重定级规则。
- 集团级须显式授权且可与其他业务维度共存，已明确；它不等于所有门店或所有业务范围。
- Q24 已明确：结构化原文件自动继承成功解析出的全部数据权限要求；只解析出 A 就按 A，解析出 A/B 就须同时满足两者，未识别内容随原件且无额外人工声明。结构化结果仍可按范围拆分，evidence 及其片段整份继承归属。
- 台账 PDF 已确定独立业务授权和类别定密，允许低于上游密级；照片内容或有效性变化使旧 PDF 失效并由每日巡检重做，单纯照片读取授权/密级变化不影响 PDF 权限、有效性或生成；其他来源转换细则见 Q34 草案。
- 当前代码仍有原台账汇总及结构化覆盖读取入口；目标已明确只交付 PDF 并取消台账汇总，实施时须统一收口相关 API/MCP、发现信息及旧游标路径，不能仅隐藏工具描述。
- evidence 维度由 admin 显式配置、结构化维度由 admin 与开发共创后接入，且新增必需维度须补齐旧资料和旧授权、启用后缺失不放行，已明确；多维度组合匹配见 Q17 及正式设计。

## Agent interview decisions — consolidated after user review

The user delegated the remaining one-question-at-a-time design decisions to a GPT-6 Astra
(high effort) subagent on 2026-10-10. Subsequent user review overrides the affected proposals;
the final target includes the user's simplification of background downloads and explicit admin
access to every same-organization account's permission settings. Implementation is pending.
The Chinese question/answer record is maintained in
[business-related-authorization-review.md](docs/implementation/business-related-authorization-review.md).

### Language

**动态全部取值（草案）**:
在一个明确业务维度上显式包含本企业当前及未来正式登记取值（含停用但保留的历史对象）的授权选择。
_Avoid_: 选择全部现有值、缺失条件、新类别通配授权、新必需维度自动补齐。

**业务范围项（草案）**:
一个同时包含归属及全部适用业务维度取值、用于完整匹配授权的实际业务范围组合。
_Avoid_: 跨授权拼接条件、将多个相关组合拍平成独立取值集合。

**业务维度值目录（草案）**:
在企业内维护业务维度取值的共享目录；门店按用户修订使用门店名称精确识别，其他维度按其明确契约定义身份。
_Avoid_: 必须新增统一商户编号、按相似名称自动合并、不同业务字段同名即同义。

### Relationships

- Q16：动态全部仅作用于授权已声明的类别、归属及维度，其他条件仍完整匹配；固定枚举不随目录增加而扩展。
- Q17：授权内同维度多值为 OR、不同维度为 AND；资料保存实际范围项列表，整份文件/共有记录的每个项均须由完整授权覆盖，不能跨项或跨授权拼条件。
- Q18：每份 evidence 恰好一个规范业务类别；类别 ID 精确匹配，名称、检索标签及组合类别名称不产生继承授权，evidence 类别不能冒充结构化或 PDF 类别。
- Q19（按用户条件修订）：代码存在可空商户号，但无贯穿业务的统一必填门店 ID；目标业务授权使用门店名精确匹配，不同名称不自动归并，不做相似度判断。现有商户号可保留，不将未知名称一律整次暂不发布或必备别名映射作为既定要求。
- Q20（用户明确确认）：会员数据属于集团级信息，不按门店分配读取权限；储值门店、开卡门店是普通数据/筛选字段，不是授权条件。会员类别集团级授权与密级足够即可读取本企业全部会员数据，原文件自动继承。撤回双门店共同授权草案。
- Q21（用户修订）：检疫照片是开发维护的固定类别；每张照片和每份台账 PDF 都必须且只能归属一家门店，照片与关联台账/PDF 门店一致；撤回 A/B 共有照片假设。
- Q22（用户确认补充）：检疫照片内容修正/替换/撤下/归档后旧 PDF 失效，每日巡检按最新有效照片重做，新版就绪后可下载，旧签发链接仍按原 TTL。单纯照片读取授权/密级变化不改变 PDF 权限，也不使其失效或重生成；重做同样不继承照片权限。供应商普通更新沿用不自动刷新历史 PDF 的规则。
- Q23：admin 通过明确管理视图读取必要元数据、权限属性、状态及脱敏错误并维护权限；该特权不开放正文/行/照片/下载，普通读取不由上传者身份决定。
- Q24（用户明确确认）：原文件自动继承其成功解析出的全部结构化数据权限要求，未识别内容随原件；只解析出 A 就按 A，解析出 A/B 就须同时满足两者。撤回完整解析覆盖清单和管理员另行确认范围的建议，此项不再待定。
- Q25：区分授权范围内查询（先限权再计算）与明确目标完整交付（缺项不成功）；普通筛选含门店名不等于承诺完整交付；错误可按修订后的 Q29 明确名称及解释性概述/汇总，不要求一律隐藏存在性。
- Q26（按用户要求简化）：相关权限变化使旧查询游标失效；打包提交时授权并固定资料清单，制作过程不因发起人业务授权/密级变化失败，也不扩缩内容。有效本人可看任务状态，领取新下载链接时按当前权限检查，拒绝链接不改成任务失败；不允许管理员接管他人普通下载，既有 URL 仍按原 TTL 有效。
- Q27（用户确认补充）：新账号无隐式业务授权，开发者开户时可显式给 admin 初始授权；employee 密级显式指定 0–3，创建为 admin 默认最高；角色切换不自动改密级/grant，开户与角色管理仍由开发/运维负责。
- Q28：已发布资料现有归档统一要求当前同企业 active admin，取消历史上传者特权；有效账号可清理自己的未完成上传，不能影响已发布/已受理处理/被引用资料。
- Q29（用户修订）：提供实时本人权限名片；错误可显示受限资料名称、概述或解释所需汇总，不必过度隐藏；正常正文、明细、下载仍鉴权，此修订不新增企业全量目录浏览能力。
- Q30：一期管理能力以统一 HTTP API 和官方 MCP 交付，当前 admin/同企业校验、原子审计与并发版本检查必需；不顺带建设完整 Web 后台或扩展账户凭证管理。
- Q31：具有独立稳定 ID 的目录项仍按原改名/停用草案；门店因 Q19 改用名称身份，不能自动套用“改名只改展示、授权全部沿用”。不同名称不自动迁移资料/授权，正式更名迁移若需要应另行定义。停用与撤权仍分开。
- Q32：新资料权限必须显式完整；固定类别先配置企业密级及所需维度/映射，缺项只可准备不可发布，不以任何默认密级/归属代替；保留旧有效版本不能绕过已启用的新规则。
- Q33：按企业准备、明确补齐确认、原子切换；启用后不再以旧权限兼容放行，技术回退也不得恢复旧读取边界，不能保障时暂停相关读取；原始资料保留，迁移执行另行授权。
- Q34：PDF 按来源类型采用明确范围转换：本门店台账、准确匹配供应商的必要字段、同一门店的检疫照片；集团来源其他适用维度不可忽略，无转换契约则不能发布。
- Q36：一期经营、菜品销售按门店；会员数据、菜品基础目录、供应商名单均为集团级且各自独立授权；原始配送台账仅内部输入，不进入员工可授予读取类别；检疫证明和台账 PDF 的“独立”指可分别授予读取权，两类每份资料均只属于一家门店。
