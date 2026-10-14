# 企业入驻与管理员权限设置入口

目标流程是：开发者把企业专属的官方权限设置 URL 发给企业管理员，管理员本人登录并在 UI 上选择、填写与维护规则。普通用户不填写 JSON。已有企业新增账号复用企业的类别、门店和维度，只补该账号的授权。

## 服务入口

权限 UI 已在当前服务实现，路径为官方服务同源 `/admin/permissions/:orgId`。开发者按目标环境验证企业专属固定 URL 后交付；页面可用不等于真实租户已配置或激活。agent 不凭本地代码或 Skill 更新推断目标页面可用，不生成临时管理凭据。

目标企业入口验证后，开发者可直接向管理员分享正式企业专属固定 URL；agent 也可向已知管理员提供已验证的入口。URL 是可收藏的入口，不是免登录赋权链接。账号未开通或缺少首位管理员时交运维处理；密码设置仍由本人在第一方浏览器完成。

管理员 UI 与登录／密码页面均支持中文和 English，首次默认中文。沿用用户明确选择的合法语言偏好，缺失或异常时中文兜底；语言切换不改变权限或业务名称。密码、会话与设置链接不得交给 agent 或写入文件。

## 用户操作约定

1. 开发／运维核对企业身份并开通组织与管理员账号，私下交付一次性密码设置链接；页面企业专属固定 URL 与密码设置链接分开说明。账号、角色和密码管理不转交本 Skill。
2. 管理员打开企业专属固定入口；同一浏览器／用户配置的官方设备网页登录状态在 30 分钟绝对有效期内可复用，失效或换浏览器需登录。服务端核对 URL 企业、账号企业与当前 admin，A 企业链接误发给 B 时拒绝访问，不泄露 A 信息、不自动改跳 B。核对当前企业和账号。新企业按首次设置引导，已有企业直接查看当前配置；不能通过 URL 参数或填写另一个组织 ID 切租户。
3. 在 UI 选择七类可读取固定类别的业务密级、精确门店与适用条件，为每个账号（包括管理员本人）选择读取类别与范围。全部门店必须说明“包含以后新增门店”，集团资料单独授权。原始配送台账继续内部使用，不展示密级配置，不要求为启用或入库设置密级，也不提供普通读取开关。配送台账 PDF 保留独立密级与授权。
4. 普通文档按整份声明类别、文件密级和完整范围；结构化原件沿用成功解析的完整数据要求，不另填原件权限。缺项不能猜测或默认成全部访问。
5. 保存前看具体变更，尤其撤权；保存成功不等于首次启用。准备报告 ready 后，当前管理员在 UI 单独确认激活。已有 enabled 企业新增账号不重复切换；legacy／preparing 仍是旧读取模型，suspended 不回退旧模型。
6. 管理员完成后，员工可通过 get_my_permissions 查看本人实时权限卡；登录或卡片本身不能证明某份业务资料已可读，实际请求由服务端判定。

## MCP 管理边界

用户明确选择 MCP 管理且已获授权时，可用[已发布的管理员 MCP 工具](business-authorization.md#admin-tools)，不要求用户填写 JSON，也不绕过服务端管理授权。先读取现有配置和最新版本、展示具体变化；账号更新是整套 grant 替换，保留未批准删除的条目。跨请求重读版本，冲突先核对，不盲目重试。

服务初始化固定类别不等于设置密级、授予 grant 或激活。已有资料缺项用只读准备报告说明；真实回填、账号创建、SQL／SSH／云端操作不属于本 Skill。普通员工不能列出其他账号配置，也不能仅凭企业专属固定 URL 取得管理权限。

用户明确选择 MCP 管理时仍可使用现有工具，不强制跳转 UI。仅在明确需要内部记录时读取[内部 JSON 约定](tenant-onboarding-json.md)；内部记录不作为用户交付要求，也不授权后台导入或真实租户切换。

七类密级流程要求服务端已部署原始台账内部类别免密级修正；若准备报告仍要求 `delivery_ledger` 密级，报告服务尚未对齐，不自动填 0／3 或删除内部类别。

## Cost cards (candidate)

The cost-card category is release gated; see [cost cards](cost-cards.md). For an already enabled
enterprise, the current admin explicitly initializes missing fixed categories through the
controlled versioned write, then configures `cost_cards` level and enterprise group grants.
Use the candidate UI button “补齐资料类别 / Add missing categories” only after saving or resolving
unsaved drafts. The write uses current string expectedVersion and returns string
authorizationVersion plus value.createdCount; a stale version requires rereading/comparison,
not blind retry. Same-origin/CSRF and current admin/tenant checks apply.
Initialization is idempotent, leaves old configuration/mode intact, and grants no default read
access. Recipe stores do not define permissions. Do not infer tenant readiness from discovery
or silently initialize through ordinary reads. No real configuration changes are authorized by
this guidance update.
