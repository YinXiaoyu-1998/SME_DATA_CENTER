# Staging 当前状态与交付前提

更新：2026-10-17。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目                   | 最新证据                                                                                                                                                                                                                                                                                                                                                                                         | 可得结论                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务部署               | [canonical run 39009318823](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39009318823) 于 2026-10-17 14:28:55 +08:00 确认成功；前置 [main quality 39008791301](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39008791301) 必需门禁通过（手动外部 provider 验证按既有条件跳过）；主机核对 API/worker 镜像均为 `ca4186bd8760`，release-ops 为 `ops-ca4186bd8760` | 已部署提交 `ca4186bd876092108225162cf13426dc6d0e5c2b`；API healthy、worker running；后续纯文档提交不代表再次部署或企业激活                                 |
| 公开客户端策略         | 2026-10-17 发布后读取官方 OAuth discovery；已发布 0.11.0 CLI self-check 与 MCP handshake 均通过                                                                                                                                                                                                                                                                                                  | issuer 为 https://api.smedatacenter.xyz，launcher 推荐 0.11.0、最低 0.6.0                                                                                  |
| npm 发行物             | `smedc-mcp-launcher@0.11.0` 经本人批准公开发布；[native release 39007346787](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39007346787) 通过 macOS/Windows/Ubuntu 验证；独立官方 registry 安装的五个包文件与 `ad66f31d22e5` 源码构建一致，生产审计零漏洞，stdio 初始化 48 tools                                                                                                 | 0.11.0 已发布并验证；新增两个门店评价工具输入均要求 `enterpriseName`                                                                                       |
| 健康与认证边界         | 2026-10-17 公开 health 200、readyz 404、主机 loopback readyz 200；未认证 `POST /v1/store-reviews/upsert` 与 `/v1/store-reviews/query` 均为 401                                                                                                                                                                                                                                                   | 健康、私有 readiness 隔离和评价接口认证边界通过                                                                                                            |
| 门店评价迁移与合成验收 | `20261017000000_store_reviews` 于 2026-10-17 14:24:43 +08:00 应用；14:26 +08:00 使用独立核验的已发布 Linux launcher、真实公开 HTTPS/MCP 和官方内存会话，在两个新建合成组织（各含企业登记）、三个账号中通过 172 项检查                                                                                                                                                                            | 企业权限、管理员写入、门店/租户读取隔离、管理员无读取绕过、评分与更新语义、员工写入拒绝和坏批次原子回滚均通过；所有合成记录/会话及本轮容器、主机目录已清理 |
| Skill 固定版本同步     | 核心独立仓库 [PR #75](https://github.com/YinXiaoyu-1998/smedc-mcp-skill/pull/75) 与扩展仓库 [PR #43](https://github.com/YinXiaoyu-1998/smedc-companion-skills/pull/43) 已合并；本仓库核心 Skill 与独立仓库及本机 canonical 副本逐文件一致                                                                                                                                                        | 核心、评价回复、经营分析与配送台账本机 Skill 指引均对齐 0.11.0；员工客户端安装另行升级                                                                     |
| 管理 UI/浏览器身份     | 当前运行代码保留企业专属管理页面及浏览器会话实现；本次未重复 Device Authorization 浏览器流程                                                                                                                                                                                                                                                                                                     | 交付某企业 URL 前仍核对其账号和租户；完整官方人工验收须独立请求                                                                                            |
| 真实企业权限           | 本次仅操作隔离合成企业，没有真实客户数据、授权、回填或平台评价回复发布                                                                                                                                                                                                                                                                                                                           | 不声明任何真实企业完成门店评价启用或业务验收                                                                                                               |

Registry shasum：`4e1d011d687b017a28d340993d9321ecbc26b5ab`；integrity：`sha512-HHPCr7p6B9M7n1NhYqHQiUbNv5/qmqr34bCzRotc5ix4c165UVnruhybZM/kfS+dll/vF7wNY6vKlyoU2CpUmw==`。

本次门店评价验收覆盖任意纯评分对象（包括自有 `__proto__` 键）、省略字段保留、`null` 清空与 `{}` 空对象的区别，以及合成回复的更新语义；这是已发布 launcher 对已部署服务的针对性验收，不是完整官方人工或真实企业验收。此前成本卡迁移、授权与 Worker 临时目录清理证据保留在 [progress](progress.md)。公开包内 README 保留发行时快照，当前安装策略以核心 Skill 为准。

## 已批准的部署目标

以下为现行运维配置入口；主机变更前按 [部署手册](staging-deploy-runbook.md) 核对目标，不能把记录值当作新的在线探测结果。

| 范围         | 配置                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务域名     | https://api.smedatacenter.xyz；公开 /healthz，/readyz 仅主机 loopback                                                                                         |
| 应用主机     | 北京轻量应用服务器 Ubuntu-yyht，实例 98872443e05742f2b64223c7462b268c，公网 39.96.66.185                                                                      |
| 运行形态     | nginx/TLS → API；独立 worker；on-demand release-ops；本地卷 Qdrant；外部 RDS MySQL                                                                            |
| ACR          | cn-beijing，crpi-yyglilct3xi9outz.cn-beijing.personal.cr.aliyuncs.com，namespace smedc；API/worker 以不可变 SHA 标记，release-ops 使用 API 仓库的 ops-SHA tag |
| 数据库       | RDS rm-2ze2m5q387ydb9724；数据库 smedc，应用账号 smedc_app；凭据通过受控 runtime 提供                                                                         |
| 对象存储     | OSS oss-cn-beijing，bucket yxy-test-sme-data-center，服务前缀 smedc/；验证使用隔离测试前缀                                                                    |
| Runtime 文件 | /opt/smedc/runtime.env，root:root 0600；当前/前一镜像记录由发布程序维护                                                                                       |
| 发布入口     | main 质量门禁 + GitHub staging Environment + smedc-staging 并发组；不用 PR 或未经批准的本地发布                                                               |
| PDF 定时     | 默认 03:00 Asia/Shanghai，可由 LEDGER_PDF_RECONCILE_TIME 配置；实际生效时刻读取目标 runtime，不沿用旧测试记录推断                                             |

## 仍需独立确认的交付门槛

- 恢复目标 RPO/RTO、负责人、获准恢复演练和测量结果。已有备份记录不等于恢复演练通过。
- 最小告警通知及处理负责人；历史 CloudMonitor 指标采集验证不等于通知规则已完成。
- 在明确授权下完成应用回滚验证，且保留前向数据库迁移和已启用的新权限边界。
- 客户资料的保留/删除、原件/当前分区备份、外部模型区域和外发批准、数据库传输策略与成本/容量决策。
- 每个客户的配置、历史补齐、明确启用及具体客户端业务验收。完整官方验收单独请求。

若这些事项没有新的证据，保留“未核实/待确认”，不得从历史成功、部署通过或登录成功推断完成。

## 安全核验方法

只记录非秘密的目标、时间、命令形状和结果。密码、DSN、AccessKey、SSH 私钥、token、完整设置链接、签名 URL、客户配置和原始数据不得写入本文件。

- 公开面：读取 /healthz、OAuth discovery；验证公开 /readyz 隔离和未认证业务拒绝。
- 主机：获准后检查当前镜像/提交、runtime 权限、loopback readiness、迁移与相关开关，不打印 runtime.env。
- OSS：仅对隔离测试对象做写/读/HEAD/删除，记录清理结果，不记录签名 URL。
- MySQL：使用受控凭据只读检查连接/目标，迁移、reset、清理或恢复另行授权。
- 更新时替换本文件的当前快照，将确有保留价值的旧证据放入历史记录；不要继续追加互相矛盾的“当前版本”。
