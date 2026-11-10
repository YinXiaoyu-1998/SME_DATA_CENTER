# Staging 当前状态与交付前提

更新：2026-11-11。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目             | 最新证据                                                                                                                                                                                                                                                        | 可得结论                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical 部署   | [部署 run 42882722735](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/42882722735) 与 [main 门禁 42881001555](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/42881001555) 成功，提交 `7b73437ed7138671d61784625c47343d2a69ac26` | API/worker 镜像为 `7b73437ed713`，健康检查和合成数据冒烟通过。前端 [部署 run 42881045787](https://github.com/YinXiaoyu-1998/SMEDC_FRONTEND/actions/runs/42881045787) 成功，线上产物为 `ec7ed24`。 |
| npm 发行物       | [发布 run 42881194615](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/42881194615) 三平台通过。维护者批准后公开 `0.18.0`，来源 `7b73437e`，shasum `c4b4eeb3656a25e71ff06944db8c48f98ab47c45`。                                                  | 从 npm 官方 registry 全新安装精确版本，签名与来源证明核验通过，CLI 返回 `0.18.0`，列出 52 个工具，员工目录查询与管理工具齐全。生产依赖审计 0 漏洞。                                               |
| 版本策略与 Skill | 源码推荐与两个核心 Skill 安装 pin 同步为 `0.18.0`，OAuth 最低版本为 `0.12.0`。                                                                                                                                                                                  | 此前部署实测线上推荐为 `0.17.0`。推荐值以本次源码变更部署后核验为准。企业工作流最低客户端版本维持 `0.17.0`，安装记录和下载回执的门槛为 `0.16.0`。                                                 |
| 工作流数据       | [员工档案与门店设计](../adr/0028-employee-directory-store-identity.md) 已随后端部署。                                                                                                                                                                           | 已有门店由企业管理员核对正式名称并确认，真实企业和宿主工作流需分别验收。                                                                                                                          |

Registry integrity：`sha512-XRMoiA5veGIDeoSq1m0luGa+Dn+gOQWrgmeQVe+jxSRLXf/mexjyyjnELU72KlZesY4EFXIN06T5VVXVoy6QKw==`。

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
- 每个客户的配置、历史补齐、明确启用及具体客户端业务验收。配置与必要历史的导入、宿主切换和真实首轮须分别验证，不能只凭 imported 标签认定完成；按[使用指南](../guides/automation-user-guide.html)先准备旧机迁移预览，再在新 Mac 检查暂停任务，明确切换后才启用。完整官方验收单独请求。

若这些事项没有新的证据，保留“未核实/待确认”，不得从历史成功、部署通过或登录成功推断完成。

## 安全核验方法

只记录非秘密的目标、时间、命令形状和结果。密码、DSN、AccessKey、SSH 私钥、token、完整设置链接、签名 URL、客户配置和原始数据不得写入本文件。

- 公开面：读取 /healthz、OAuth discovery；验证公开 /readyz 隔离和未认证业务拒绝。
- 主机：获准后检查当前镜像/提交、runtime 权限、loopback readiness、迁移与相关开关，不打印 runtime.env。
- OSS：仅对隔离测试对象做写/读/HEAD/删除，记录清理结果，不记录签名 URL。
- MySQL：使用受控凭据只读检查连接/目标，迁移、reset、清理或恢复另行授权。
- 更新时替换本文件的当前快照，将确有保留价值的旧证据放入历史记录；不要继续追加互相矛盾的“当前版本”。
