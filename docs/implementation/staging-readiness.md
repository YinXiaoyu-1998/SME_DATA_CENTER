# Staging 当前状态与交付前提

更新：2026-10-15。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目                | 最新证据                                                                                                                                                                                                                                                                    | 可得结论                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 服务部署            | [canonical run 38754647761](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/38754647761) 成功；前置 [main quality 38753292348](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/38753292348) 通过；主机核对 API/worker 镜像均为 `37bde1f8200b` | 已部署运行代码提交 `37bde1f8200b4a3fac3855b5738de15052d0fed1`；后续纯文档提交不代表另一次部署，也不能据此推断企业已激活 |
| 公开客户端策略      | 2026-10-15 发布后读取官方 OAuth discovery                                                                                                                                                                                                                                   | issuer 为 https://api.smedatacenter.xyz，launcher 推荐 0.10.1、最低 0.6.0                                               |
| npm 发行物          | `smedc-mcp-launcher@0.10.1` 经本人批准公开发布；独立官方 registry 安装验证五个文件与 `24c494ba8313` 源码构建一致、生产审计零漏洞、stdio 初始化 46 tools                                                                                                                     | 0.10.1 已发布并验证；成本卡下载/归档描述已修正；当前安装按双归属核心 Skill 的固定版本流程                               |
| 健康与认证边界      | 2026-10-15 Worker 补丁部署后公开 health 200、readyz 404、两个成本卡写/下载入口未认证均 401；canonical 部署与 fixture smoke 通过                                                                                                                                             | 健康、私有 readiness 隔离和接口认证边界通过                                                                             |
| Worker 临时目录清理 | 新 Worker 上线后核对：维护任务已删除 48 小时前的合成 `cost-*` 与 `pjob_*` 目录，保留 1 小时前的成本卡目录和无关目录；验证后仅本轮四个测试目录均无残留                                                                                                                       | 成本卡崩溃残留已纳入现有 24 小时过期清理；验证使用合成 CSV，不读取或修改业务数据                                        |
| 成本卡迁移与授权    | 此前 0.10.0 发布已验证 `20261014080000_cost_cards` 迁移及 legacy 合成 QA 企业 manifest/coverage 的 403 拒绝；本次 0.10.1 补丁无新增迁移                                                                                                                                     | 保留此前迁移/授权边界证据；本次不重复完整成本卡业务验收或操作真实企业权限                                               |
| 管理 UI/浏览器身份  | 上述运行代码包含企业专属管理页面及浏览器会话实现                                                                                                                                                                                                                            | 交付某企业 URL 前仍核对其账号和租户                                                                                     |
| 真实企业权限        | 本次没有读取或修改真实客户授权状态，没有真实成本卡导入、补齐或启用操作                                                                                                                                                                                                      | 不声明任何真实企业完成成本卡业务验收                                                                                    |

Registry integrity：`sha512-LYeoTSXnxLp0JfPGg0dM7cJAGJTKWyUw7HWjGaiv52XTXY7m3gLW9kasOMtr21s2YS5lIKA9VptpmPhZzp2OJA==`。

本次 Worker 补丁修复成本卡本地临时目录的过期清理，已验证实际镜像、合成目录清理及公开健康/认证边界；未重复完整成本卡业务验收或真实企业操作。此前 launcher 0.10.1 发行物证据继续保留，历史功能验收见 [progress](progress.md)。公开包内 README 保留发行时快照，当前安装策略以核心 Skill 为准。

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
