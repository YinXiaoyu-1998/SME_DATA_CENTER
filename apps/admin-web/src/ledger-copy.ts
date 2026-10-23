import type { LocalizedText } from "./pages.js";
export const ledgerCopy = {
  title: { zh: "台账 PDF 下载中心", en: "Ledger PDF downloads" },
  intro: {
    zh: "按门店与进货日期查找、核对并下载已生成的台账。",
    en: "Find, review and download generated ledgers by store and purchase date."
  },
  access: {
    zh: "仅显示当前账号有权读取的文件。今日未就绪不影响历史可用文件。",
    en: "Only files you can currently read are shown. Today's pending files do not block available history."
  },
  store: { zh: "门店精确名称", en: "Exact store name" },
  loadedStores: {
    zh: "已加载门店（非完整门店目录）",
    en: "Loaded stores (not a complete directory)"
  },
  allStores: {
    zh: "留空查询所有受权门店；保留名称原有空格。",
    en: "Leave empty for all authorized stores. Preserve spaces in the name."
  },
  startDate: { zh: "进货日期 · 起", en: "Purchase date · From" },
  endDate: { zh: "进货日期 · 止", en: "Purchase date · To" },
  search: { zh: "查询台账", en: "Find ledgers" },
  querying: { zh: "正在查询…", en: "Finding ledgers…" },
  list: { zh: "台账文件", en: "Ledger files" },
  listNote: {
    zh: "本批 {count} 项 · 每批最多 {limit} 项",
    en: "{count} items in this batch · Up to {limit} per batch"
  },
  empty: {
    zh: "本次查询无受权进货记录。请调整筛选条件。",
    en: "No authorized purchase records match this query. Adjust your filters."
  },
  initial: { zh: "选择日期后查询台账。", en: "Choose dates to find ledgers." },
  date: { zh: "进货日期", en: "Purchase date" },
  status: { zh: "状态", en: "Status" },
  size: { zh: "文件大小", en: "File size" },
  actions: { zh: "操作", en: "Actions" },
  selectBatch: { zh: "全选本批可选文件", en: "Select available files in this batch" },
  selectFile: { zh: "选择 {store} · {date}", en: "Select {store} · {date}" },
  ready: { zh: "可下载", en: "Ready" },
  pending: { zh: "等待生成", en: "Pending" },
  stale: { zh: "待更新", en: "Out of date" },
  missing: { zh: "暂无文件", en: "Missing" },
  unverified: { zh: "待核验 / 不可读", en: "Unverified / unavailable" },
  unknown: { zh: "大小未知", en: "Unknown size" },
  preview: { zh: "预览", en: "Preview" },
  previewTitle: { zh: "PDF 预览", en: "PDF preview" },
  previewEmpty: { zh: "选择一份可用台账核对内容。", en: "Choose an available ledger to review." },
  previewWaiting: {
    zh: "正在加载 PDF…其他文件仍可操作。",
    en: "Loading PDF… Other files remain available."
  },
  viewerHint: {
    zh: "使用浏览器 PDF 工具翻页和缩放。无法显示时，可直接下载查看。",
    en: "Use the browser PDF controls to page and zoom. If the viewer is unavailable, download the file."
  },
  download: { zh: "下载", en: "Download" },
  downloading: { zh: "正在读取…", en: "Retrieving…" },
  downloadStarted: {
    zh: "下载已发起，请查看浏览器下载记录。",
    en: "Download initiated. Check your browser downloads."
  },
  previous: { zh: "上一批", en: "Previous batch" },
  next: { zh: "下一批", en: "Next batch" },
  batch: { zh: "第 {batch} 批", en: "Batch {batch}" },
  selection: { zh: "已选清单", en: "Selected files" },
  selectedSummary: {
    zh: "已选 {files} / {limit} 份 · {stores} 家门店 · {dates} 个日期",
    en: "{files} / {limit} files · {stores} stores · {dates} dates"
  },
  byteSummary: {
    zh: "已知大小 {bytes} · 剩余 {remaining} · 超出 {over}",
    en: "Known size {bytes} · Remaining {remaining} · Over {over}"
  },
  unknownSummary: {
    zh: "{unknown} 份大小未知，{invalid} 份待核验或不可用；请核验或移除后提交。",
    en: "{unknown} sizes unknown; {invalid} files unverified or unavailable. Recheck or remove them before submitting."
  },
  selectionHint: {
    zh: "跨批次、跨查询保留勾选，仅保存在本页内存。刷新页面会清空。",
    en: "Selections span batches and queries and live only in this page. Reloading clears them."
  },
  limits: {
    zh: "每次最多 {files} 份 · {stores} 家门店 · {dates} 个不同日期 · 原 PDF 合计 {bytes}。查询跨度最多 {dates} 天。",
    en: "Up to {files} files · {stores} stores · {dates} distinct dates · {bytes} of original PDFs. Query spans up to {dates} days."
  },
  overLimit: {
    zh: "已超出限制。所有勾选均保留，请自行取消部分文件。",
    en: "Selection exceeds a limit. All files remain selected; remove some to continue."
  },
  selectionOrder: {
    zh: "全部已选文件，按已知大小从大到小排列。",
    en: "All selected files, largest known size first."
  },
  remove: { zh: "移除", en: "Remove" },
  clear: { zh: "清空选择", en: "Clear selection" },
  prepare: { zh: "打包下载 ZIP", en: "Prepare ZIP" },
  preparing: { zh: "正在提交…", en: "Submitting…" },
  newPrepare: { zh: "重新准备当前清单", en: "Prepare current selection again" },
  records: { zh: "本页操作记录", en: "This page's activity" },
  recordsHint: {
    zh: "仅记录本页的单份下载和打包任务，刷新后不保留。",
    en: "Single downloads and ZIP tasks from this page only. Not retained after reload."
  },
  recordsEmpty: { zh: "尚未发起下载或打包。", en: "No downloads or ZIP tasks yet." },
  task: { zh: "打包任务", en: "ZIP task" },
  taskSelection: {
    zh: "本次固定清单：{count} 份。后续勾选不会改变此任务。",
    en: "Fixed selection: {count} files. Later selections do not change this task."
  },
  taskHint: {
    zh: "任务最长处理 {minutes} 分钟；生成的包保留 {hours} 小时，领取的链接最长 15 分钟有效。可关闭窗口继续浏览。",
    en: "Tasks run for up to {minutes} minutes; packages are retained for {hours} hours and links last up to 15 minutes. Close this dialog to keep browsing."
  },
  queued: { zh: "排队中", en: "Queued" },
  running: { zh: "正在打包", en: "Preparing ZIP" },
  succeeded: { zh: "打包完成，可领取下载链接", en: "ZIP ready; request a download link" },
  failed: { zh: "打包失败", en: "Failed" },
  partial_failed: { zh: "任务未完整完成", en: "Task incomplete" },
  superseded: { zh: "任务已替代", en: "Superseded" },
  getLink: { zh: "领取下载链接", en: "Get download link" },
  linking: { zh: "正在核验并领取…", en: "Checking access and getting link…" },
  expires: { zh: "本次链接到期：{time}", en: "This link expires: {time}" },
  retry: { zh: "重试", en: "Retry" },
  refresh: { zh: "重新核验", en: "Recheck access" },
  close: { zh: "关闭", en: "Close" },
  signIn: { zh: "在新页面重新登录", en: "Sign in in a separate page" },
  recovering: {
    zh: "正在核验当前账号和全部已选文件…",
    en: "Checking your current account and all selected files…"
  },
  signOut: { zh: "退出网页登录", en: "Sign out of browser" },
  BROWSER_SIGN_IN_REQUIRED: {
    zh: "网页登录已失效。已选清单保留在此页；请在新页面登录后返回并重新核验。",
    en: "Your browser sign-in expired. Selections remain here. Sign in separately, return, then recheck access."
  },
  BROWSER_SECURITY_CHECK_FAILED: {
    zh: "安全上下文已变化，请重新核验后操作。",
    en: "The security context changed. Recheck access before continuing."
  },
  NETWORK_ERROR: {
    zh: "网络请求失败。筛选和清单已保留，请重试。",
    en: "Network request failed. Filters and selection are retained. Retry when ready."
  },
  INTERNAL_ERROR: {
    zh: "服务暂时无法完成请求，请稍后重试。",
    en: "The service could not complete this request. Please retry later."
  },
  LEDGER_PDF_NOT_ENABLED: {
    zh: "台账交付服务暂不可用，请稍后重试或联系管理员。",
    en: "Ledger delivery is currently unavailable. Retry later or contact your administrator."
  },
  LEDGER_SCOPE_INVALID: {
    zh: "请核对门店原名及有效日期，起始日期不能晚于结束日期。",
    en: "Check the exact store name and valid dates. From cannot be later than To."
  },
  LEDGER_SCOPE_LIMIT_EXCEEDED: {
    zh: "查询或清单超过数量、门店或日期限制，请缩小范围。",
    en: "The query or selection exceeds file, store or date limits. Reduce the scope."
  },
  LEDGER_CURSOR_INVALID: {
    zh: "本批游标已失效，请重新查询；已选清单仍保留。",
    en: "This batch cursor expired. Search again; selected files are retained."
  },
  LEDGER_REQUEST_INVALID: {
    zh: "任务请求无效，请重新准备。",
    en: "Invalid task request. Prepare a new task."
  },
  LEDGER_IDEMPOTENCY_CONFLICT: {
    zh: "此请求对应不同清单，请明确重新准备当前清单。",
    en: "This request belongs to a different selection. Prepare the current selection again."
  },
  LEDGER_PDF_UNAVAILABLE: {
    zh: "文件或任务当前不可读取，请重新核验账号与清单。",
    en: "The file or task is unavailable. Recheck your account and selection."
  },
  LEDGER_PDF_NOT_READY: {
    zh: "所选文件尚未全部就绪。请等待每日更新，其他历史可用文件仍可下载。",
    en: "Some selected files are not ready. Wait for daily processing; other available historical files remain downloadable."
  },
  LEDGER_PDF_BUNDLE_STALE: {
    zh: "下载包已过期或内容失效，请重新核验并准备。",
    en: "The package expired or its content changed. Recheck and prepare again."
  },
  LEDGER_DOWNLOAD_REBUILD_REQUIRED: {
    zh: "需要重新核验并准备下载包。",
    en: "Recheck your selection and prepare a new package."
  },
  AUTHORIZATION_VERSION_CONFLICT: {
    zh: "权限已变化，请重新核验全部已选文件。",
    en: "Permissions changed. Recheck all selected files."
  },
  LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED: {
    zh: "原 PDF 合计超过容量限制，请取消部分文件。",
    en: "Original PDF size exceeds the limit. Remove some files."
  }
} satisfies Record<string, LocalizedText>;
