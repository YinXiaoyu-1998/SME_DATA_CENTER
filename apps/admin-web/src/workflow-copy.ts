export const workflowCopy: Record<string, { zh: string; en: string }> = {
  installHelp: {
    zh: "保存业务设置后，请在自己的 Codex 安装所选自动任务并运行准备检查。来源登录、邮件连接与文件验证在执行电脑完成。",
    en: "After saving settings, install the selected task in your Codex and run preparation checks. Source sign-in, mail connections and file verification happen on the execution computer."
  },
  noEnterprises: {
    zh: "请先在权限设置登记业务企业，再设置自动任务。",
    en: "Register a business enterprise in Permissions before configuring tasks."
  },
  title: {
    zh: "自动任务",
    en: "Automatic tasks"
  },
  intro: {
    zh: "业务配置由 SMEDC 保存，实际定时任务由您电脑上的 Codex 执行。",
    en: "SMEDC saves business settings; Codex on your computer schedules and runs tasks."
  },
  enterprise: {
    zh: "业务企业",
    en: "Business enterprise"
  },
  choose: {
    zh: "请选择",
    en: "Choose"
  },
  loading: {
    zh: "正在读取…",
    en: "Loading…"
  },
  refresh: {
    zh: "读取最新状态",
    en: "Refresh status"
  },
  compare: {
    zh: "比较最新配置",
    en: "Compare latest settings"
  },
  keep: {
    zh: "保留草稿",
    en: "Keep draft"
  },
  discard: {
    zh: "采用最新配置并放弃草稿",
    en: "Use latest and discard draft"
  },
  latest: {
    zh: "服务端最新配置",
    en: "Latest saved settings"
  },
  draft: {
    zh: "当前页面草稿",
    en: "Current draft"
  },
  conflict: {
    zh: "配置已被其他操作更改。草稿已保留；请比较最新配置后重新确认。",
    en: "Settings changed elsewhere. Your draft is retained; compare the latest settings and confirm again."
  },
  expired: {
    zh: "登录已过期或权限已改变。请重新打开原入口并登录。草稿不会自动提交。",
    en: "Sign-in expired or access changed. Reopen the original entry and sign in. Drafts will not be submitted automatically."
  },
  security: {
    zh: "安全校验失败，请重新打开原入口。",
    en: "Security check failed. Reopen the original entry."
  },
  invalid: {
    zh: "请检查必填项、精确来源身份和范围；没有保存任何变更。",
    en: "Check required fields, exact source identities and scope. No changes were saved."
  },
  unexpected: {
    zh: "操作未完成，请稍后重试或联系管理员。",
    en: "The operation could not complete. Retry later or contact your administrator."
  },
  saved: {
    zh: "已保存。配置保存不代表任务已安装或启用。",
    en: "Saved. Saving settings does not install or enable a task."
  },
  notConfigured: {
    zh: "尚未配置",
    en: "Not configured"
  },
  empty: {
    zh: "暂无记录",
    en: "No records"
  },
  noStores: {
    zh: "未登记标准门店。请先在权限设置中登记。",
    en: "No standard stores registered. Add stores in Permissions first."
  },
  permissionsLink: {
    zh: "权限设置",
    en: "Permissions"
  },
  logout: {
    zh: "退出网页登录",
    en: "Sign out of browser"
  },
  "meituan-daily-ingestion": {
    zh: "每日数据采集入库",
    en: "Daily data ingestion"
  },
  "meituan-review-operations": {
    zh: "评价处理",
    en: "Review operations"
  },
  "weekly-business-report": {
    zh: "自然周经营周报",
    en: "Weekly business report"
  },
  integration: {
    zh: "企业共用来源设置",
    en: "Shared enterprise sources"
  },
  sourceHelp: {
    zh: "多个来源店铺可对应同一家标准门店。来源身份必须精确，不自动合并相似名称。排除项必须填写原因。",
    en: "Several source stores may map to one standard store. Exact identities are required; similar names are never merged automatically. Exclusions require a reason."
  },
  sourceAccounts: {
    zh: "来源账号",
    en: "Source accounts"
  },
  product: {
    zh: "来源产品",
    en: "Source product"
  },
  meituan_erp: {
    zh: "美团管家",
    en: "Meituan ERP"
  },
  meituan_reviews: {
    zh: "经营宝",
    en: "Business management"
  },
  accountRef: {
    zh: "账号标记（用于区分来源账号）",
    en: "Account reference (distinguishes source accounts)"
  },
  displayName: {
    zh: "账号显示名称",
    en: "Account display name"
  },
  sourceEnterpriseName: {
    zh: "来源企业名称",
    en: "Source enterprise name"
  },
  sourceGroupName: {
    zh: "来源集团名称（可选）",
    en: "Source group name (optional)"
  },
  storeMappings: {
    zh: "来源门店对应",
    en: "Source store mappings"
  },
  sourceStoreName: {
    zh: "来源店铺精确名称",
    en: "Exact source store name"
  },
  sourceStoreId: {
    zh: "来源店铺编号（可选）",
    en: "Source store number (optional)"
  },
  channel: {
    zh: "来源渠道",
    en: "Source channel"
  },
  erp: {
    zh: "美团管家",
    en: "Meituan ERP"
  },
  meituan: {
    zh: "美团",
    en: "Meituan"
  },
  dianping: {
    zh: "大众点评",
    en: "Dianping"
  },
  storeName: {
    zh: "标准门店",
    en: "Standard store"
  },
  exclusions: {
    zh: "明确排除的来源店铺",
    en: "Explicitly excluded source stores"
  },
  reason: {
    zh: "原因",
    en: "Reason"
  },
  add: {
    zh: "添加",
    en: "Add"
  },
  remove: {
    zh: "移除",
    en: "Remove"
  },
  saveIntegration: {
    zh: "预览来源设置",
    en: "Preview source settings"
  },
  configuration: {
    zh: "任务业务设置",
    en: "Task settings"
  },
  stores: {
    zh: "处理门店",
    en: "Stores to process"
  },
  storesRequired: {
    zh: "请至少选择一家处理门店。",
    en: "Select at least one store."
  },
  datasetsRequired: {
    zh: "请至少选择一种数据。",
    en: "Select at least one dataset."
  },
  channelsRequired: {
    zh: "请至少选择一个评价渠道。",
    en: "Select at least one review channel."
  },
  publicationInvalid: {
    zh: "发布门店必须是采集门店的明确非空子集。",
    en: "Publication requires an explicit nonempty subset of collection stores."
  },
  groupsInvalid: {
    zh: "分组名称不得重复，每组需有门店，同一门店只能属于一组，且必须在处理范围内。",
    en: "Group names must be unique, each group needs stores, and each selected store can belong to only one group."
  },
  mailInvalid: {
    zh: "启用邮件需填写允许的发件人和有效收件人（最多 20 个，不得重复）。",
    en: "Enabled email requires an allowed sender and valid recipients (up to 20, without duplicates)."
  },
  datasets: {
    zh: "采集数据",
    en: "Datasets"
  },
  business: {
    zh: "营业数据",
    en: "Business data"
  },
  dishes: {
    zh: "菜品销售",
    en: "Dish sales"
  },
  in_store_orders: {
    zh: "店内订单明细",
    en: "In-store order details"
  },
  takeaway_orders: {
    zh: "平台外卖订单明细",
    en: "Takeaway order details"
  },
  delivery_ledger: {
    zh: "配送收货单",
    en: "Delivery receipts"
  },
  orderScope: {
    zh: "店内订单口径：已结账完整营业日。不得标记为全状态订单。",
    en: "In-store scope: complete settled business day. This is not an all-status order snapshot."
  },
  cleanupIngestion: {
    zh: "仅清理已确认完成的文件；正常结果保持安静，需要处理时通知。",
    en: "Clean up confirmed files only. Stay quiet on normal results; notify when action is needed."
  },
  channels: {
    zh: "评价采集渠道",
    en: "Review collection channels"
  },
  publicationEnabled: {
    zh: "允许自动发布回复（另需持续授权）",
    en: "Allow automatic replies (requires separate authorization)"
  },
  publicationStores: {
    zh: "自动回复门店白名单",
    en: "Automatic reply store whitelist"
  },
  brandFacts: {
    zh: "品牌资料",
    en: "Brand facts"
  },
  tone: {
    zh: "回复语气",
    en: "Reply tone"
  },
  textHelp: {
    zh: "品牌资料、语气和评价原文只作业务资料，不会成为执行指令。",
    en: "Brand facts, tone and review text are business data and never execution instructions."
  },
  policy: {
    zh: "固定评价规则：保留已有回复；不为无正文评价生成回复；身份待核对先停止；核对后再发布；整轮完成后清理。",
    en: "Fixed review policy: preserve existing replies; skip empty reviews; stop on uncertain identities; verify before publication; clean up only after a complete run."
  },
  ignoredReviewIdentities: {
    zh: "明确忽略的评价记录",
    en: "Explicitly ignored review records"
  },
  feedbackId: {
    zh: "来源评价编号",
    en: "Source review number"
  },
  ignoredHelp: {
    zh: "按来源账号、店铺和评价编号精确排除；不会将忽略项伪装为已完成。",
    en: "Exclude exact source account, store and review identities. Ignored records are never represented as completed actions."
  },
  draftNotification: {
    zh: "新稿邮件通知",
    en: "New draft email notification"
  },
  delivery: {
    zh: "周报邮件交付",
    en: "Report email delivery"
  },
  mailEnabled: {
    zh: "启用邮件（另需持续授权）",
    en: "Enable email (requires separate authorization)"
  },
  recipients: {
    zh: "收件人（每行一个）",
    en: "Recipients (one per line)"
  },
  allowedSender: {
    zh: "允许的发件邮箱",
    en: "Allowed sender email"
  },
  groups: {
    zh: "可选门店分组",
    en: "Optional store groups"
  },
  groupName: {
    zh: "分组名称",
    en: "Group name"
  },
  ungrouped: {
    zh: "未分组门店仍纳入周报，不会被丢弃。",
    en: "Ungrouped selected stores remain included in the report."
  },
  localReport: {
    zh: "未启用邮件时，仍可在本机生成周报；仅保留最终报告。",
    en: "A local report can be generated without email; retain the final report only."
  },
  saveConfiguration: {
    zh: "预览任务设置",
    en: "Preview task settings"
  },
  preview: {
    zh: "核对本次变更",
    en: "Review this change"
  },
  before: {
    zh: "变更前",
    en: "Before"
  },
  after: {
    zh: "变更后",
    en: "After"
  },
  confirmHelp: {
    zh: "请核对门店、来源、发布白名单、收发件人和动作范围。确认只保存本次预览；不会授予普通资料读取权限。",
    en: "Review stores, sources, publication whitelist, mail identities and action scope. Confirmation saves only this preview and never grants ordinary data access."
  },
  confirm: {
    zh: "确认本次变更",
    en: "Confirm this change"
  },
  cancel: {
    zh: "取消",
    en: "Cancel"
  },
  expires: {
    zh: "预览有效至",
    en: "Preview expires at"
  },
  authorizations: {
    zh: "持续授权",
    en: "Standing authorizations"
  },
  authorizationHelp: {
    zh: "业务配置与持续授权分别保存。授权不能替代账号的数据访问权限；外部动作仍由服务端实时检查。",
    en: "Settings and standing authorization are saved separately. Authorization does not replace account data access; the server rechecks every external action."
  },
  grant: {
    zh: "新增授权",
    en: "New authorizations"
  },
  revoke: {
    zh: "预览撤销选中授权",
    en: "Preview selected revocations"
  },
  action: {
    zh: "授权动作",
    en: "Authorized action"
  },
  upload: {
    zh: "采集入库",
    en: "Upload collected data"
  },
  download: {
    zh: "下载经营数据",
    en: "Download business data"
  },
  review_sync: {
    zh: "采集评价",
    en: "Collect reviews"
  },
  review_publish: {
    zh: "公开发布回复",
    en: "Publish public replies"
  },
  email: {
    zh: "发送邮件",
    en: "Send email"
  },
  purpose: {
    zh: "用途",
    en: "Purpose"
  },
  review_drafts: {
    zh: "评价新稿通知",
    en: "Review draft notification"
  },
  weekly_report: {
    zh: "周报交付",
    en: "Weekly report delivery"
  },
  exception: {
    zh: "异常通知",
    en: "Exception notification"
  },
  deliveryVersion: {
    zh: "本次交付批次",
    en: "Delivery revision"
  },
  control: {
    zh: "执行控制",
    en: "Execution control"
  },
  active: {
    zh: "已启用",
    en: "Active"
  },
  paused: {
    zh: "已暂停",
    en: "Paused"
  },
  revoked: {
    zh: "已撤销",
    en: "Revoked"
  },
  enabled: {
    zh: "已启用",
    en: "Enabled"
  },
  pending: {
    zh: "待准备",
    en: "Pending"
  },
  not_installed: {
    zh: "未安装",
    en: "Not installed"
  },
  activate: {
    zh: "预览启用",
    en: "Preview activation"
  },
  pause: {
    zh: "预览暂停",
    en: "Preview pause"
  },
  revokeControl: {
    zh: "预览撤销执行资格",
    en: "Preview execution revocation"
  },
  activateHelp: {
    zh: "启用会要求后续新订单上传声明来源口径。仅在准备就绪并完成旧任务交接后确认；保存配置不会改动现有任务。",
    en: "Activation requires source scope for subsequent new order uploads. Confirm only after preparation and old-task handoff. Saving settings does not change existing tasks."
  },
  status: {
    zh: "指定电脑与最近状态",
    en: "Designated computer and recent status"
  },
  statusHelp: {
    zh: "这是最近一次已记录状态，非离线实时监控。实际时间、模型和调度在 Codex 修改。",
    en: "This is the latest recorded status, not real-time offline monitoring. Change schedule and model in Codex."
  },
  designated: {
    zh: "指定执行电脑",
    en: "Designated computer"
  },
  notAssigned: {
    zh: "尚未指定电脑",
    en: "No computer assigned"
  },
  preparation: {
    zh: "准备检查",
    en: "Preparation checks"
  },
  firstRun: {
    zh: "首次真实运行验证",
    en: "First real-run verification"
  },
  verified: {
    zh: "已验证",
    en: "Verified"
  },
  unverified: {
    zh: "未验证",
    en: "Not verified"
  },
  no_sample: {
    zh: "没有样本，未验证文件格式",
    en: "No sample; file format unverified"
  },
  not_checked: {
    zh: "尚未检查",
    en: "Not checked"
  },
  ready: {
    zh: "准备就绪",
    en: "Ready"
  },
  needs_configuration: {
    zh: "需要配置",
    en: "Needs configuration"
  },
  needs_login: {
    zh: "需要登录",
    en: "Sign-in required"
  },
  permission_denied: {
    zh: "权限不足",
    en: "Permission denied"
  },
  unsupported: {
    zh: "暂不支持",
    en: "Unsupported"
  },
  unavailable: {
    zh: "暂不可用",
    en: "Unavailable"
  },
  permissions: {
    zh: "资料访问权限",
    en: "Data access permissions"
  },
  workspace: {
    zh: "本机工作目录",
    en: "Local workspace"
  },
  dependencies: {
    zh: "依赖工具",
    en: "Dependencies"
  },
  email_identity: {
    zh: "发件身份",
    en: "Sender identity"
  },
  sent_mail_lookup: {
    zh: "已发送邮件核对",
    en: "Sent mail lookup"
  },
  host_schedule: {
    zh: "Codex 调度",
    en: "Codex schedule"
  },
  host_timezone: {
    zh: "时区",
    en: "Timezone"
  },
  host_model: {
    zh: "执行模型",
    en: "Execution model"
  },
  assignment: {
    zh: "指定电脑资格",
    en: "Assigned computer eligibility"
  },
  file_format: {
    zh: "实际文件格式",
    en: "Actual file format"
  },
  nextStep: {
    zh: "下一步",
    en: "Next step"
  },
  checkedAt: {
    zh: "最近检查时间",
    en: "Last checked"
  },
  schedule: {
    zh: "最近确认的调度快照",
    en: "Last confirmed schedule snapshot"
  },
  cron: {
    zh: "执行计划",
    en: "Schedule"
  },
  model: {
    zh: "模型",
    en: "Model"
  },
  reasoningEffort: {
    zh: "推理强度",
    en: "Reasoning effort"
  },
  verifiedAt: {
    zh: "快照核对时间",
    en: "Snapshot verified at"
  },
  pendingActions: {
    zh: "未解决动作",
    en: "Unresolved actions"
  },
  intent: {
    zh: "请求已记录，尚未确认完成",
    en: "Request recorded; completion unconfirmed"
  },
  unknown: {
    zh: "结果未知，先核对再处理",
    en: "Unknown outcome; reconcile first"
  },
  runs: {
    zh: "最近运行",
    en: "Recent runs"
  },
  running: {
    zh: "进行中",
    en: "Running"
  },
  succeeded: {
    zh: "已确认成功",
    en: "Confirmed success"
  },
  partial: {
    zh: "部分完成",
    en: "Partially complete"
  },
  needs_attention: {
    zh: "需要处理",
    en: "Action required"
  },
  failed: {
    zh: "失败",
    en: "Failed"
  },
  window: {
    zh: "业务日期范围",
    en: "Business date window"
  },
  more: {
    zh: "加载更多",
    en: "Load more"
  },
  possibleMissed: {
    zh: "可能漏跑预期日期，请在 Codex 核对；补数需单独确认日期范围。",
    en: "The expected window may have been missed. Check in Codex; backfills require a separately confirmed date range."
  },
  observedAt: {
    zh: "状态读取时间",
    en: "Status observed at"
  },
  minimumLauncher: {
    zh: "所需客户端最低版本",
    en: "Minimum client version"
  },
  sourceConflict: {
    zh: "来源映射缺失、重复或冲突，请核对精确来源和标准门店。",
    en: "Source mappings are missing, duplicated or conflicting. Check exact source identities and standard stores."
  },
  busy: {
    zh: "另一轮仍在执行或交接条件尚未满足，请先核对状态。",
    en: "Another run is active or handoff conditions are unmet. Review status first."
  },
  configurationRequired: {
    zh: "请先保存任务业务设置并完成来源配置。",
    en: "Save task settings and finish source configuration first."
  },
  versionIncompatible: {
    zh: "客户端或工作流版本不兼容，请在 Codex 更新后重新检查。",
    en: "Client or workflow versions are incompatible. Update in Codex and recheck."
  },
  requestReference: {
    zh: "请求编号",
    en: "Request reference"
  },
  preserved: {
    zh: "已有未展示设置仍保留，请先核对来源配置。",
    en: "Existing settings outside this view are preserved; review source configuration."
  },
  storeNames: {
    zh: "门店范围",
    en: "Store scope"
  },
  publication: {
    zh: "自动回复发布设置",
    en: "Automatic reply publication"
  },
  source: {
    zh: "来源身份",
    en: "Source identity"
  },
  kind: {
    zh: "动作",
    en: "Action"
  },
  state: {
    zh: "执行状态",
    en: "Execution state"
  },
  name: {
    zh: "分组名称",
    en: "Group name"
  },
  scope: {
    zh: "授权范围",
    en: "Authorized scope"
  },
  revokedScopes: {
    zh: "撤销的授权范围",
    en: "Scopes to revoke"
  },
  grantedAt: {
    zh: "授权时间",
    en: "Granted at"
  },
  revokedAt: {
    zh: "撤销时间",
    en: "Revoked at"
  },
  not_run: {
    zh: "尚未进行真实运行验证",
    en: "Real-run verification not yet performed"
  },
  dataset: {
    zh: "数据类型",
    en: "Dataset"
  },
  startDate: {
    zh: "开始日期",
    en: "Start date"
  },
  endDate: {
    zh: "结束日期",
    en: "End date"
  },
  sender: {
    zh: "发件人",
    en: "Sender"
  },
  recipient: {
    zh: "收件人",
    en: "Recipient"
  },
  reviewIdentities: {
    zh: "评价与收件人范围",
    en: "Review and recipient scope"
  },
  yes: {
    zh: "是",
    en: "Yes"
  },
  no: {
    zh: "否",
    en: "No"
  },
  noReadAccess: {
    zh: "此页面不授予账号资料读取权限；权限设置仍需分别完成。",
    en: "This page does not grant account data access. Configure permissions separately."
  },
  revokeSelection: {
    zh: "选择撤销此授权",
    en: "Select this authorization for revocation"
  },
  sourceAccountHelp: {
    zh: "账号标记只是来源的非秘密称呼，请勿填写密码、令牌或 Cookie。",
    en: "An account reference is a non-secret source label. Never enter passwords, tokens or cookies."
  },
  pendingHelp: {
    zh: "未知动作必须先核对，不能直接重发。请将下列业务范围交给 Codex 核对；此处不把未确认动作标为成功。",
    en: "Reconcile unknown actions before retrying. Ask Codex to check the business scope below; unconfirmed actions are never marked successful here."
  },
  settled_only: {
    zh: "已结账完整营业日",
    en: "Complete settled business day"
  },
  exclude_source_record: {
    zh: "明确排除此来源记录",
    en: "Explicitly exclude this source record"
  },
  customer_reply: {
    zh: "顾客评价回复",
    en: "Customer review reply"
  },
  minimal: {
    zh: "最少",
    en: "Minimal"
  },
  low: {
    zh: "低",
    en: "Low"
  },
  medium: {
    zh: "中",
    en: "Medium"
  },
  high: {
    zh: "高",
    en: "High"
  },
  xhigh: {
    zh: "更高",
    en: "Extra high"
  },
  max: {
    zh: "最高",
    en: "Maximum"
  },
  ultra: {
    zh: "超高",
    en: "Ultra"
  },
  previewGrant: {
    zh: "预览新增授权",
    en: "Preview authorization"
  }
};
