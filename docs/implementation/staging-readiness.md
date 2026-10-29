# Staging 当前状态与交付前提

更新：2026-10-29。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目             | 最新证据                                                                                                                                                                                                                                                                                                                                                                                | 可得结论                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical 部署   | [部署 run 40838989174](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40838989174) 成功，提交 `2668accbb78c7b6c74898b142ec5fa614023e303`；对应 [main 质量门禁 40838156384](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40838156384) 成功                                                                                                             | 合计尾行修复及后续撤销找零兼容均已部署；客户端验收版本和覆盖范围见下方，不由部署成功推定                                                                                    |
| 客户端策略与本机 | 2026-10-29 官方 `0.14.0` launcher self-check：服务 reachable/metadataCompatible、推荐 `0.14.0`、最低 `0.12.0`，本机 secure store 可用、MCP handshake 为 `ok`；已安装核心 Skill 与官方 `main@6b82f30` 的 13 个文件逐字节一致                                                                                                                                                             | 当前本机与线上版本策略兼容；安装/自检不授予类别或门店权限                                                                                                                   |
| npm 发行物       | 官方 registry 的 `0.14.0` 与 `latest` 已公开；shasum `576e25d79a352a1e909861c462e6caeae5ed9a88`，来源提交 `3f4eeff`；[发布 run 40699910260](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40699910260) 三平台验收及暂存成功，维护者批准后公开，provenance 对应该提交和工作流                                                                                           | 全新精确版本安装、CLI、48 个工具及四处订单 schema 核验通过；解压后五文件与审阅源码构建逐字节一致；生产审计零漏洞，114 个安装包签名及其中 19 个包的 attestations 验证通过    |
| 最近主机核验     | 2026-10-29 只读核对运行中的 API/worker 镜像均为 `2668accbb78c`，API 为 healthy；未输出运行凭据或读取业务内容                                                                                                                                                                                                                                                                            | 当前运行镜像与 canonical 发布一致；schema 迁移证据以该发布工作流为限                                                                                                        |
| 业务与客户端验收 | 2026-10-29 在 [PR #290](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/pull/290) 的 `f35faa9` 版本及 [部署 40727339055](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40727339055) 上，用当前登录账号通过独立新 chat 完成原始 XLSX 上传至 `published`、授权 CSV 冷读；逐条核对全部 30 个来源字段和派生结账方式 JSON；本轮分区、关联资源及本地导出精确清理后残留为 0 | 该账号/范围下的订单上传、读取和合计尾行修复验收通过；保留原账号、登录和授权。未运行完整官方业务/账号生命周期或其他客户端套件；后续 PR #291 的撤销找零兼容未纳入本轮手动覆盖 |

Registry integrity：`sha512-DOkNW+dzmJUETEsnLdt6SRXvcnrRUIbF/tav26d52d6Cf+gEjA5spkUCGDrt7qgT3f/KN1dE5DxqHPmfNHilrA==`。

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
- 每个客户的配置、历史补齐、明确启用及具体客户端业务验收。完整官方验收单独请求。

若这些事项没有新的证据，保留“未核实/待确认”，不得从历史成功、部署通过或登录成功推断完成。

## 安全核验方法

只记录非秘密的目标、时间、命令形状和结果。密码、DSN、AccessKey、SSH 私钥、token、完整设置链接、签名 URL、客户配置和原始数据不得写入本文件。

- 公开面：读取 /healthz、OAuth discovery；验证公开 /readyz 隔离和未认证业务拒绝。
- 主机：获准后检查当前镜像/提交、runtime 权限、loopback readiness、迁移与相关开关，不打印 runtime.env。
- OSS：仅对隔离测试对象做写/读/HEAD/删除，记录清理结果，不记录签名 URL。
- MySQL：使用受控凭据只读检查连接/目标，迁移、reset、清理或恢复另行授权。
- 更新时替换本文件的当前快照，将确有保留价值的旧证据放入历史记录；不要继续追加互相矛盾的“当前版本”。
