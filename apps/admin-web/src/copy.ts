export const permissionsCopy = {
  categories: { zh: "类别密级", en: "Category levels" },
  stores: { zh: "门店与业务企业", en: "Stores and businesses" },
  dimensions: { zh: "业务条件", en: "Business conditions" },
  accounts: { zh: "账号授权", en: "Account permissions" },
  documents: { zh: "普通文档", en: "Documents" },
  readiness: { zh: "检查与启用", en: "Check and activate" },
  intro: {
    zh: "先设置类别密级与业务目录，再为账号授权。保存配置与启用权限是两个独立步骤。",
    en: "Set category levels and business directories, then grant account access. Saving and activation are separate steps."
  },
  legacy: { zh: "未启用 · 仍按原有规则读取", en: "Not activated · original read rules apply" },
  preparing: { zh: "准备中 · 仍按原有规则读取", en: "Preparing · original read rules apply" },
  enabled: { zh: "已启用业务权限", en: "Business permissions enabled" },
  suspended: { zh: "业务读取已暂停", en: "Business reads suspended" },
  loading: { zh: "正在读取配置…", en: "Loading configuration…" },
  save: { zh: "保存", en: "Save" },
  saving: { zh: "正在保存…", en: "Saving…" },
  saved: { zh: "已保存。", en: "Saved." },
  noChange: { zh: "没有需要保存的变更。", en: "No changes to save." },
  refresh: { zh: "重新读取配置", en: "Reload configuration" },
  compare: { zh: "比较最新配置", en: "Compare latest configuration" },
  cancel: { zh: "取消", en: "Cancel" },
  confirm: { zh: "确认变更", en: "Confirm changes" },
  changeTitle: { zh: "确认本次变更", en: "Confirm these changes" },
  discardTitle: { zh: "重新读取会替换未保存的内容", en: "Reloading replaces unsaved changes" },
  discard: { zh: "放弃草稿并重新读取", en: "Discard drafts and reload" },
  keepDraft: { zh: "保留草稿", en: "Keep drafts" },
  discardHelp: {
    zh: "当前页面的未保存内容仍保留在后台。请比较后选择是否放弃；不会自动合并或覆盖。",
    en: "Unsaved fields remain on this page. Compare before discarding; changes are never automatically merged or overwritten."
  },
  conflict: {
    zh: "配置已被其他操作更新。你的草稿已保留；请比较最新配置后重新读取并确认，不能直接重试覆盖。",
    en: "Another operation changed the configuration. Your drafts are preserved. Compare, reload and confirm again; retrying cannot overwrite it."
  },
  expired: {
    zh: "网页登录已过期或已撤销。未提交内容不会自动保存，请重新登录。",
    en: "Your browser sign-in expired or was revoked. Unsaved changes will not be submitted automatically. Sign in again."
  },
  denied: {
    zh: "当前账号无权访问此企业的权限设置。请核对账号与链接。",
    en: "This account cannot access this enterprise's permissions. Check your account and link."
  },
  security: {
    zh: "安全校验失败，请重新打开原链接并登录。",
    en: "The security check failed. Reopen the original link and sign in."
  },
  invalid: {
    zh: "配置不完整或引用不可用，请核对类别、门店和业务条件。",
    en: "Configuration is incomplete or references an unavailable item. Check categories, stores and conditions."
  },
  unavailable: {
    zh: "目标已不可用，请重新读取并核对。",
    en: "The target is unavailable. Reload and check it."
  },
  unexpected: {
    zh: "操作未完成，请稍后重试；若持续失败，请联系运维并提供请求编号。",
    en: "The operation did not complete. Retry later; if it persists, contact your operator with the request reference."
  },
  requestReference: { zh: "请求编号", en: "Request reference" },
  signIn: { zh: "重新登录", en: "Sign in again" },
  required: {
    zh: "请完成必填项；密级、范围和取值不能留空。",
    en: "Complete the required fields. Levels, scopes and values cannot be empty."
  },
  differentConditions: {
    zh: "所选类别的业务条件不一致，请拆成不同授权条目。",
    en: "These categories require different conditions. Use separate grants."
  },
  invalidGrant: {
    zh: "请核对授权条目的类别、归属、门店和完整业务条件。",
    en: "Check the grant's categories, ownership, stores and complete conditions."
  },
  unset: { zh: "未配置", en: "Not configured" },
  choose: { zh: "请选择", en: "Choose" },
  level: { zh: "密级", en: "Confidentiality level" },
  clearance: { zh: "账号密级", en: "Account clearance" },
  levelHelp: {
    zh: "0–3 级都需要显式业务授权；0 不代表公开，管理员普通读取也需授权。",
    en: "Every level from 0 to 3 requires an explicit business grant. Level 0 is not public; administrators also need grants for ordinary reads."
  },
  fixedHelp: {
    zh: "各可读取的固定类别分别配置密级，未配置项不会自动设为 0。",
    en: "Configure every readable fixed category level. Unset levels are never defaulted to 0."
  },
  initializeCategories: { zh: "补齐资料类别", en: "Add missing categories" },
  initializeCategoriesHelp: {
    zh: "补齐服务已支持的资料类别。新增类别的密级保持未配置；请随后设置密级和账号授权。",
    en: "Add supported categories that are missing. New levels stay unset; configure their levels and account grants afterward."
  },
  initializeDrafts: {
    zh: "请先保存或处理未保存的草稿，再补齐资料类别。",
    en: "Save or resolve unsaved drafts before adding missing categories."
  },
  internalLedger: {
    zh: "原始配送台账仅供内部处理，不提供原始明细、汇总或原件读取。",
    en: "Raw delivery ledgers remain internal and do not expose rows, summaries or originals."
  },
  business: { zh: "营业数据", en: "Business data" },
  dishes: { zh: "菜品销售", en: "Dish sales" },
  delivery_ledger: { zh: "原始配送台账（内部）", en: "Raw delivery ledger (internal)" },
  ledger_pdf: { zh: "配送台账 PDF", en: "Delivery ledger PDF" },
  quarantine_certificate: { zh: "检疫证明", en: "Quarantine certificates" },
  vip: { zh: "会员资料", en: "Member data" },
  dish_catalog: { zh: "菜品目录", en: "Dish catalog" },
  supplier_catalog: { zh: "供应商目录", en: "Supplier catalog" },
  store_reviews: { zh: "店铺评价", en: "Store reviews" },
  cost_cards: { zh: "成本卡", en: "Cost cards" },
  name: { zh: "名称", en: "Name" },
  retired: { zh: "已停用", en: "Retired" },
  retire: {
    zh: "停用此项（保留历史引用）",
    en: "Retire this item (preserve historical references)"
  },
  active: { zh: "可用", en: "Available" },
  addCategory: { zh: "新增普通文档类别", en: "Add document category" },
  evidenceHelp: {
    zh: "普通文档按文件设置密级。类别定义可用的归属与所需业务条件。",
    en: "Document levels are set per file. Categories define supported ownership and required business conditions."
  },
  ownership: { zh: "资料归属", en: "Ownership" },
  store: { zh: "门店资料", en: "Store materials" },
  group: { zh: "集团资料", en: "Group materials" },
  groupHelp: {
    zh: "集团资料需要单独授权，不等同于全部门店。",
    en: "Group materials need a separate grant; all stores does not include group materials."
  },
  requiredConditions: { zh: "必需业务条件", en: "Required conditions" },
  addDimension: { zh: "新增业务条件", en: "Add condition" },
  addValue: { zh: "新增取值", en: "Add value" },
  values: { zh: "可选取值", en: "Available values" },
  dimensionHelp: {
    zh: "例如项目或部门。不同条件组合用不同授权条目，避免把交叉范围扩大。",
    en: "For example, project or department. Use separate grants for different tuples to avoid expanding cross-combinations."
  },
  enterprise: { zh: "业务企业", en: "Business enterprise" },
  declareEnterprise: { zh: "新增业务企业", en: "Add business enterprise" },
  newEnterprise: { zh: "新增企业…", en: "New enterprise…" },
  enterpriseName: { zh: "业务企业名称", en: "Business name" },
  enterpriseHelp: {
    zh: "选择已有业务企业，或在新增门店时填写新企业名称。企业信息在保存时自动建立，与评价是否已有数据无关。",
    en: "Choose an existing business or enter a new business name when adding a store. Saving creates its enterprise information, even when no reviews exist."
  },
  automaticEnterpriseHelp: {
    zh: "新增企业时，企业名称与门店一起保存，无需额外登记。密级和账号读取权限仍由你单独设置。",
    en: "For a new enterprise, its name and store are saved together with no separate registration. Configure category levels and account read access separately."
  },
  enterpriseNameRequired: {
    zh: "请先在“门店与业务企业”保存企业名称或新增该企业的门店，再保存评价授权。现有权限未改变。",
    en: "Save the business name or its first store under Stores and businesses before saving review access. Existing permissions are unchanged."
  },
  enterpriseNameConflict: {
    zh: "企业名称与已有企业信息冲突。请重新读取配置，核对名称后再保存；系统不会自动更名或合并。",
    en: "The business name conflicts with the saved enterprise. Reload and confirm the name before saving; enterprises are never automatically renamed or merged."
  },
  enterpriseDeclared: {
    zh: "确认后保存本组织的业务企业名称；此操作不授予任何读取权限。",
    en: "Confirmation saves this business name in the current organization. It does not grant read access."
  },
  addStore: { zh: "新增精确门店", en: "Add exact store" },
  storeName: { zh: "精确门店名称", en: "Exact store name" },
  storeHelp: {
    zh: "保留完整原名。停用不删除历史引用；更名或合并须另行核对迁移。",
    en: "Keep the exact full name. Retirement preserves historical references; renaming or merging requires a separate reviewed migration."
  },
  account: { zh: "账号", en: "Account" },
  role: { zh: "角色（只读）", en: "Role (read only)" },
  admin: { zh: "管理员", en: "Administrator" },
  employee: { zh: "员工", en: "Employee" },
  disabled: { zh: "账号已停用", en: "Account disabled" },
  accountHelp: {
    zh: "账号创建和角色变更由运维处理。每次保存替换该账号完整授权，未修改的条目会保留。",
    en: "Operators create accounts and change roles. Saving replaces this account's complete grant set while preserving entries you did not edit."
  },
  grants: { zh: "读取授权", en: "Read grants" },
  addGrant: { zh: "新增授权条目", en: "Add grant" },
  removeGrant: { zh: "删除此授权条目", en: "Remove this grant" },
  removeScope: { zh: "删除此范围", en: "Remove this scope" },
  noGrants: {
    zh: "无读取授权。账号密级本身不授予资料读取权。",
    en: "No read grants. Account clearance alone does not grant access."
  },
  noStoreRead: { zh: "无门店读取权限", en: "No store read access" },
  selectedStores: { zh: "指定门店", en: "Selected stores" },
  allStores: { zh: "全部门店（包括以后新增）", en: "All stores (including future stores)" },
  selectedValues: { zh: "指定取值", en: "Selected values" },
  allValues: { zh: "全部取值（包括以后新增）", en: "All values (including future values)" },
  noGrantOption: {
    zh: "不需要读取某类资料时，不添加该类别授权；删除条目即撤权。",
    en: "For no access to a category, omit its grant. Removing a grant revokes that access."
  },
  preserved: {
    zh: "不可用条目（保留历史选择）",
    en: "Unavailable item (historical selection preserved)"
  },
  removeCondition: { zh: "移除此条件", en: "Remove this condition" },
  categoriesLabel: { zh: "允许读取的类别", en: "Readable categories" },
  grantCount: { zh: "授权条目数", en: "Grant count" },
  before: { zh: "原配置", en: "Before" },
  after: { zh: "本次配置", en: "After" },
  latest: { zh: "最新服务端配置", en: "Latest server configuration" },
  draft: { zh: "当前未保存草稿", en: "Current unsaved draft" },
  searchDocument: { zh: "按文档名称或 ID 查找", en: "Find by document name or ID" },
  search: { zh: "查找", en: "Search" },
  nextPage: { zh: "下一页", en: "Next page" },
  firstPage: { zh: "返回第一页", en: "First page" },
  document: { zh: "文档", en: "Document" },
  documentHelp: {
    zh: "这里只显示权限属性，不提供正文或下载。每页最多 50 份文档；上传继续使用官方 MCP。",
    en: "Only permission metadata is shown, with no content or downloads. Pages contain up to 50 documents. Uploads continue through official MCP."
  },
  documentCategory: { zh: "普通文档类别", en: "Document category" },
  scopes: { zh: "整份文档的完整范围", en: "Complete document scopes" },
  addScope: { zh: "新增范围", en: "Add scope" },
  documentStatus: { zh: "处理状态", en: "Processing status" },
  attributesNotReady: {
    zh: "资料权限属性或处理状态尚未就绪。",
    en: "Document permission attributes or processing status are not ready."
  },
  supplementReason: {
    zh: "历史补齐原因（仅获准补齐时填写）",
    en: "Historical supplement reason (approved work only)"
  },
  supplementHelp: {
    zh: "不自动猜测来源或回填真实资料；缺项先按准备报告另行核对并批准。",
    en: "Sources and real-data backfills are never inferred. Review missing items separately and obtain approval."
  },
  check: { zh: "运行只读准备检查", en: "Run read-only preparation check" },
  ready: { zh: "配置准备就绪", en: "Configuration ready" },
  notReady: { zh: "尚有缺项，暂不能启用", en: "Missing items prevent activation" },
  empty: { zh: "暂无条目", en: "No items yet" },
  target: { zh: "对象", en: "Target" },
  issue: { zh: "待处理事项", en: "Required action" },
  accountsWithoutGrants: {
    zh: "以下账号没有读取授权（启用后仍无读取权）",
    en: "These accounts have no read grants (they remain unable to read after activation)"
  },
  activate: { zh: "确认启用业务权限", en: "Confirm business permission activation" },
  activateHelp: {
    zh: "启用后本企业读取将按新业务权限判定。保存不等于启用；历史缺项必须先补齐。",
    en: "Activation switches this enterprise's reads to business permissions. Saving is not activation; historical missing items must be resolved first."
  },
  alreadyEnabled: {
    zh: "本企业已启用。新增账号只需保存授权，无需再次激活。",
    en: "This enterprise is already enabled. New accounts only need their grants saved, without reactivation."
  },
  suspendedHelp: {
    zh: "读取已暂停，请联系运维核对恢复要求。本页不回退旧规则或绕过准备恢复。",
    en: "Reads are suspended. Contact your operator about recovery. This page cannot restore legacy rules or bypass preparation."
  },
  activated: {
    zh: "已启用业务权限。请在批准范围内做最小读取验证。",
    en: "Business permissions enabled. Perform a minimal read verification within the approved scope."
  },
  noDataClaim: {
    zh: "新空企业可先配置并启用；没有真实资料时只能声明配置就绪。",
    en: "An empty enterprise can be configured and activated first. With no real documents, only configuration readiness can be claimed."
  },
  version: { zh: "配置版本", en: "Configuration version" },
  INTERNAL_CATEGORY_REQUIRED: {
    zh: "内部资料类别尚未初始化，请联系运维。",
    en: "An internal data category has not been initialized. Contact your operator."
  },
  FIXED_CATEGORY_CLEARANCE_REQUIRED: {
    zh: "请配置固定类别密级",
    en: "Configure the fixed category level"
  },
  DIMENSION_NOT_READY: {
    zh: "请补齐类别所需业务条件",
    en: "Complete the category's required conditions"
  },
  DIMENSION_VALUE_REQUIRED: { zh: "请核对业务条件取值", en: "Check condition values" },
  EXACT_STORE_REFERENCE_REQUIRED: {
    zh: "请补齐精确门店引用",
    en: "Complete exact store references"
  },
  GRANT_CONFIGURATION_REQUIRED: {
    zh: "请修正账号的完整授权组合",
    en: "Correct the account's complete grant tuples"
  },
  GRANT_DIMENSION_REQUIRED: {
    zh: "请补齐授权的业务条件取值",
    en: "Complete grant condition values"
  },
  PARTITION_ATTRIBUTES_REQUIRED: {
    zh: "结构化资料属性缺失，请联系运维核对",
    en: "Structured material attributes are missing; contact your operator"
  },
  COST_CARD_ATTRIBUTES_REQUIRED: {
    zh: "成本卡权限属性缺失，请联系运维核对",
    en: "Cost card permission attributes are missing; contact your operator"
  },
  PDF_ATTRIBUTES_REQUIRED: {
    zh: "台账 PDF 属性缺失，请联系运维核对",
    en: "Ledger PDF attributes are missing; contact your operator"
  },
  READ_ADAPTER_NOT_READY: {
    zh: "服务读取能力尚未就绪，请联系运维",
    en: "Server read support is not ready; contact your operator"
  },
  RESOURCE_ATTRIBUTES_REQUIRED: {
    zh: "请补齐资料类别、密级和完整范围",
    en: "Complete the material's category, level and scopes"
  },
  STORE_REVIEW_ATTRIBUTES_REQUIRED: {
    zh: "店铺评价的企业或门店关联缺失，请核对",
    en: "Check the review’s enterprise and exact store references"
  },
  RESOURCE_CATEGORY_MISMATCH: {
    zh: "资料与类别不匹配，请核对",
    en: "Check the material's category mismatch"
  },
  SINGLE_STORE_REQUIRED: {
    zh: "此资料必须对应一个精确门店",
    en: "This material must belong to one exact store"
  },
  SOURCE_LINEAGE_REQUIRED: {
    zh: "原件来源关系缺失，须另行核对与批准补齐",
    en: "Source lineage is missing; review and approve any supplement separately"
  },
  DOCUMENT_ATTRIBUTES_REQUIRED: {
    zh: "文档权限属性缺失，请核对",
    en: "Document permission attributes are missing"
  },
  uploading: { zh: "上传中", en: "Uploading" },
  pending_processing: { zh: "等待处理", en: "Waiting for processing" },
  processing: { zh: "处理中", en: "Processing" },
  processing_failed: { zh: "处理失败", en: "Processing failed" },
  archived: { zh: "已归档", en: "Archived" }
} as const;
