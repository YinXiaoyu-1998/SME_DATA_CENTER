# SMEDC（企业资料中枢）当前领域模型

本文件是全仓库唯一领域术语入口，只记录当前契约及最终决策。部署证据见 [staging 状态](docs/implementation/staging-readiness.md)；操作前仍须核对目标环境与租户模式。

## 服务边界

SMEDC 为员工自有 agent、CLI、MCP 和 API 提供资料存储、受权检索、结构化数据和最小管理界面。员工自己的 agent 负责理解问题、分析和生成报告；服务不提供聊天代理、报表/看板生成器、自然语言 SQL 或 Skill 执行器。

## 身份与权限术语

| 术语                               | 当前含义                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| 员工账号 Employee Account          | 后端授权主体，关联组织、admin/employee 角色、0–3 密级、业务 grant、停用状态和审计身份      |
| 登录身份 Login Identity            | 与一个员工账号绑定的凭据身份；不是 token 或 agent 安装                                     |
| 组织 Organization                  | 账号和资源必须共同所属的租户边界；客户端不得任意选择组织                                   |
| 业务企业 Enterprise                | 组织内由服务规范化的业务身份，使用 enterpriseKey；同名门店不能跨企业合并                   |
| 功能角色 Functional Role           | admin/employee；admin 可管理本组织配置、执行声明的特权操作和上传，不隐式获得普通正文读取权 |
| 账号密级 Confidentiality Clearance | 0–3 的账号级别；与业务授权共同决定读取权。admin 可修改本企业所有账号（含自己）的密级       |
| 业务类别 Business Category         | 明确的读取授权单位；结构化/照片/PDF 类别由开发维护，evidence 类别由 admin 创建             |
| 业务范围项 Business Scope Item     | 企业、集团/门店归属及全部适用维度的一个实际组合，不能拆成额外交叉组合                      |
| 业务授权 Business Grant            | 明确类别、归属和全部适用维度的允许集合；无隐式新类别授权                                   |
| 动态全部 Dynamic All               | 在已声明维度上包含现有和未来取值；不同于选中当前所有值，不自动包含新类别或新必需维度       |
| 普通读取 Ordinary Read             | 搜索、查询、下载、覆盖、内容元数据等按当前完整业务权限返回的资料访问                       |
| 管理操作 Administrative Operation  | 当前同组织 admin 的配置/安全运行信息操作；不附带正文、业务行、照片或下载能力               |
| 权限名片 Permission Card           | 当前账号本人的实时密级、完整 grant 和相关类别规则；普通员工不能列出别人的配置              |

每个实际范围项必须被至少一条完整 grant 覆盖；不能拼接不同 grant 的类别和门店。门店按同一企业内名称精确匹配，不做相似度合并。集团级不是“全部门店”的别名。固定类别使用企业当前类别密级，evidence 使用明确的逐文件密级。账号停用、跨组织、资源无效、属性不完整或授权不足均拒绝普通读取。

新账号无隐式业务授权；运维可显式配置并审计初始 grant。新建 admin 默认密级 3，employee 须明确密级；后续角色变化不自动改变已有密级/grant。账号、组织、角色和密码操作仍由运维负责。

权限规则的完整定义与例子分别见 [权限设计](docs/implementation/business-related-authorization-design.md) 和 [使用说明](docs/implementation/business-related-authorization-guide.md)。

## 资料与数据术语

| 术语                                       | 当前含义                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Evidence                                   | MD/TXT/DOCX 的处理方式；每份明确一个业务类别、逐文件密级及完整范围。不是独立的业务授权类别                 |
| 源文档 ID Source Document ID               | 服务生成的受保护原文件标识，不是收货单号、文件名或存储键                                                   |
| 收货单据号 Receipt ID                      | 业务单据关联键，API/MCP 使用 receiptId，结构化字段使用 receipt_id                                          |
| 保留原件 Retained Original                 | 实际保留的原文件；结构化原件继承该文件成功解析出的全部数据要求，未识别内容不另外推定权限                   |
| 当前经营分区 Current Structured Partition  | 一个组织/业务企业/business 或 dishes/门店身份/营业日的权威 canonical CSV；OSS 保存字节，MySQL 保存当前目录 |
| 分区清单 Partition Manifest                | 经过权限筛选、短期有效的当前分区清单；launcher 消费内部链接并交付校验后的本地文件                          |
| 检疫证明 Quarantine Certificate            | JPG/JPEG/PNG 原件，每张明确一个企业和一家精确门店，可按 receiptId 先于收货单上传                           |
| 台账 PDF Ledger PDF                        | 内部来源转换产生的单门店/日期成品，使用独立 PDF 类别及密级，不反向授予来源读取权                           |
| 来源文件下载链接 Source File Download Link | 服务鉴权后签发的原件访问能力，24 小时有效；不是永久链接                                                    |

`business`/`dishes` 的临时来源在处理终态后清理，不保留源工作簿、MySQL 明细行或分区历史版本；源文件整体原子发布当前分区。其分析在 launcher 下载后的本地环境完成。

`vip`、`dish_catalog`、`supplier_catalog` 为独立集团级类别，保留受控行查询与原件关联。会员开卡/储值门店是业务字段，不是授权维度。`delivery_ledger` 保留内部导入/生成用途，不开放员工原始行、汇总、覆盖或原件下载。

Evidence 的每个片段继承整件完整权限；更改文件属性后按当前 MySQL 权限重验，旧索引不能放行。照片及 PDF 各自只能属于一家门店。PDF 引用该店台账、匹配供应商必要字段和同店照片；新增来源/维度必须有明确转换契约。

照片内容、有效性或门店关联改变会使相关 PDF 失效并等待计划重生成；单纯读取权限/密级变化不会使 PDF 失效或改变 PDF 权限。供应商普通更新不自动重做历史 PDF。

## 查询、任务与发布

查询先限权再计算；明确的完整文件/分区交付不能静默删掉无权目标后报告完整成功。错误可说明必要的资料名称或概述，但不交付正文、明细或链接。

下载打包在提交时授权并固定清单，制作按内部任务身份完成，不因发起人中途权限变化改为失败。有效本人可查看安全进度，领取新链接时按当前完整权限再校验；已签发 URL 按原 TTL 使用。来源损坏/失效、租约和完整性检查仍适用。

上传由当前有效 admin 发起；上传成功不等于处理或 PDF 生成完成。worker 使用租约、attempt 和原子发布门禁，失去租约的旧任务不能发布。

## 客户端与会话

员工自有 agent 通过 MCP host 启动官方 stdio launcher；launcher 持有协议凭据并连接远端 HTTPS 服务，agent/model 不接触密码或 token。

统一使用 OAuth Device Authorization：员工在第一方网页确认 agent 实例并登录，launcher 在后端轮询获取会话。桌面、手机遥控本机和无头远端均可使用；完全无人交互登录不在支持范围。

支持的 OS 安全存储保存轮换 durable credential；无安全存储时仅保留 launcher 进程内存，重启后重新登录。浏览器身份会话独立于 launcher，会话、安装、恢复和卸载契约见 [正式登录说明](docs/implementation/official-user-install-and-login.md)。

## 入驻与激活

企业专属管理页面复用第一方浏览器身份，服务端每次校验 URL 企业、当前账号和 admin 身份。默认中文，可切换 English；普通用户不填写内部 JSON。

`legacy`/`preparing` 是尚未启用新业务授权的准备模式；`enabled` 使用完整业务授权；`suspended` 拒绝受影响读取且不回退旧模型。配置保存、只读准备和管理员明确激活是不同操作。部署不授权真实资料补齐或租户激活。

## Skill 目录

当前服务返回经批准的 Skill 目录元数据，不执行条目。技能包上传/托管的已确认但尚未实现范围见 [Skills Shop 决策](docs/implementation/skills-shop.md)，不得把该决策当成现有 API。
