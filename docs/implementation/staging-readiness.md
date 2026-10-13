# Staging 当前状态与交付前提

更新：2026-10-13。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目               | 最新证据                                                                                                                                                                                                   | 可得结论                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 服务部署           | [canonical run 38238929827](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/38238929827)，2026-10-12，main@75604ec504d2e42b22eaba33dd91638d393f5382，Deploy staging 成功，rollback 步骤跳过 | 当前 main 对应的正式 staging 发布流程已成功；不能据此推断每个租户已激活  |
| 公开客户端策略     | 2026-10-13 读取官方 OAuth discovery                                                                                                                                                                        | issuer 为 https://api.smedatacenter.xyz，launcher 推荐 0.9.0、最低 0.6.0 |
| npm 发行物         | 2026-10-13 查询官方 registry 的 smedc-mcp-launcher@0.9.0；integrity 与 2026-10-11 独立安装记录一致                                                                                                         | 0.9.0 已发布；完整安装/44-tool 契约验证证据保留在 progress               |
| 管理 UI/浏览器身份 | 上述已部署提交包含企业专属管理页面及浏览器会话实现                                                                                                                                                         | “尚未实现/尚未部署”的旧描述不再适用；交付某企业 URL 前仍核对其账号和租户 |
| 真实企业权限       | 本次仅检查发布记录和公开元数据，没有读取或修改客户授权状态                                                                                                                                                 | 不声明任何真实企业完成补齐、激活或业务验收                               |

Registry integrity：`sha512-LKgGjws8PIbv42oQ9u3TL1JTrbBFDXnIsRqnv6E6tNoU7VQME51EB7E89bzY+rWmxBZqL4R8TpFoR72sSQ6KGg==`。

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
