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
