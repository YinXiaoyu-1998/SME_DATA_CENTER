# Staging 当前状态与交付前提

更新：2026-11-02。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目             | 最新证据                                                                                                                                                                                                                                                                                | 可得结论                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical 部署   | [部署 run 41405921819](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/41405921819) 成功；提交 `360d33acbadbb285d7410de5d360e677c285d47f`；[main 门禁 41405137679](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/41405137679) 成功并复用同 SHA 已验镜像 | API/worker 实际镜像 `360d33acbadb`；loopback readiness 200，公开 health 200、readyz 404；正式 fixture smoke 成功                                                                                                           |
| npm 发行物       | [发布 run 41394111691](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/41394111691) 三平台通过；维护者批准后公开 `0.16.0`，来源 `8d3677dc`，shasum `0a30b1f4f186cff9e0ff70f62bc1050bf3791573`                                                                            | 官方 registry 全新精确安装 CLI 0.16.0；全部五个文件与审阅源码构建字节一致，SDK 内存传输发现 57 项工具，工作流/订单合同与额外组织字段拒绝通过，生产 audit 零漏洞；该合同核验使用 SDK 内存传输，不冒充用户登录或真实业务验收 |
| 版本策略与 Skill | 主仓 PR #307、核心 Skill PR #94 已合并；公开 OAuth 推荐 0.16.0，最低保持 0.12.0；订单已有能力最低仍为 0.15.0；15 文件核心目录一致                                                                                                                                                       | 工作流与来源口径能力需要 0.16.0 及实时服务检查。没有修改本机既有安装、登录或三个定时任务；安装与部署不授予业务权限                                                                                                         |
| 工作流迁移       | `20261102100000_enterprise_workflow_foundation`、`20261102110000_order_scope_transition`、`20261102120000_workflow_migration_chunks`、`20261102130000_workflow_live_policy` 均于北京时间 2026-11-02 13:42:11 完成，无 rollback                                                          | 新增配置、安装、租约、回执和分页迁移结构；历史订单仅标未知，不推断为已结账或全部状态。保存暂停草案不启用任务；显式启用店内采集后的旧镜像回退有兼容保护                                                                     |
| 权限与线上核验   | 发布前后 12 组原有角色、密级、停用状态、类别、门店及 grant 元数据摘要相同；一次性合成企业的三类配置保存/读回、版本冲突、组织隔离、管理员/停用检查和重复登记通过                                                                                                                         | 合成账号与数据已清理；核验后中央工作流、集成及 order-scope-required 集成均为 0。没有真实企业配置导入、取数、发信、回复或接管；新 Mac 与真实来源验收仍由用户进行                                                            |

Registry integrity：`sha512-1pL9tkeUFwH5SPXj9JAyCHlJRO0UtE7jILLAuDudjGgfebrN3NBzLFyvWvbhdUj49SnLtQRNuwTo1J3eDTOXgQ==`。

当前安装 pin 由[核心 Skill](../../skills/smedc-mcp/SKILL.md)维护；companion 的版本归属见
[三仓维护契约](smedc-mcp-skill.md)。仓库同步不等于更新员工本机安装。
公开包内 README 是发行时快照；历史发布、部署和清理证据保留在 progress 及
[历史记录](../history/staging-verification.md)，不得当作新的执行授权。

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
- 每个客户的配置、历史补齐、明确启用及具体客户端业务验收。现有三任务的真实配置与必要完成记录尚未迁入；按[使用指南](../guides/automation-user-guide.html)先准备旧机迁移预览，再在新 Mac 检查暂停任务，明确切换后才启用。完整官方验收单独请求。

若这些事项没有新的证据，保留“未核实/待确认”，不得从历史成功、部署通过或登录成功推断完成。

## 安全核验方法

只记录非秘密的目标、时间、命令形状和结果。密码、DSN、AccessKey、SSH 私钥、token、完整设置链接、签名 URL、客户配置和原始数据不得写入本文件。

- 公开面：读取 /healthz、OAuth discovery；验证公开 /readyz 隔离和未认证业务拒绝。
- 主机：获准后检查当前镜像/提交、runtime 权限、loopback readiness、迁移与相关开关，不打印 runtime.env。
- OSS：仅对隔离测试对象做写/读/HEAD/删除，记录清理结果，不记录签名 URL。
- MySQL：使用受控凭据只读检查连接/目标，迁移、reset、清理或恢复另行授权。
- 更新时替换本文件的当前快照，将确有保留价值的旧证据放入历史记录；不要继续追加互相矛盾的“当前版本”。
