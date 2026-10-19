# Staging 当前状态与交付前提

更新：2026-10-19（发布核验时点 03:32 UTC）。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目                   | 最新证据                                                                                                                                                                                                                                                                                                                                              | 可得结论                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本次服务部署           | [canonical run 39195067204](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39195067204) 在 2026-10-19 03:32 UTC 仍进行中；前置 [main quality 39194302220](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39194302220) 成功                                                                                            | 尚未确认本次部署、replyStatus 迁移或业务验收完成；本次源码推荐 0.12.0，不能当作线上已生效                                                                  |
| 此前核实部署           | [canonical run 39025476463](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39025476463) 成功；前置 [main quality 39024886873](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39024886873) 必需门禁通过，手动外部 provider 检查按既有条件跳过；API/worker 实际镜像为 `0d0c5ed9ff51`，release-ops 为 `ops-0d0c5ed9ff51` | 已部署 `0d0c5ed9ff51f2bcf60d099d54653a99f88680ca`；API healthy、worker running；后续纯文档提交不代表再次部署                                               |
| 公开客户端策略         | 2026-10-19 发布核验：官方 registry 独立安装的 0.12.0 CLI self-check 为 ok，公开服务 reachable/metadataCompatible、MCP handshake 通过                                                                                                                                                                                                                  | 观测到的线上推荐仍为 0.11.0、最低 0.6.0；源码推荐 0.12.0 待本次同步与后续部署核验                                                                          |
| npm 发行物             | `smedc-mcp-launcher@0.12.0` 经本人批准公开发布，官方 registry latest=0.12.0；[native release 39194302218](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/39194302218) 通过 macOS/Windows/Ubuntu 验证；五个包文件与 `b3a2af706ca5` 构建逐字节一致，生产审计零漏洞，独立安装 CLI 为 0.12.0，stdio 初始化 48 tools                       | 0.12.0 已发布并独立验证；replyStatus/replyStatuses 为可选输入，均含四个平台状态。包验证不证明服务迁移或租户启用                                            |
| 健康与认证边界         | 2026-10-17 公开 health 200、readyz 404、主机 loopback readyz 200；未认证 `POST /v1/store-reviews/upsert` 与 `/v1/store-reviews/query` 均为 401                                                                                                                                                                                                        | 健康、私有 readiness 隔离和评价接口认证边界通过                                                                                                            |
| 门店评价迁移与合成验收 | 此前 0.11.0 发布验收：`20261017000000_store_reviews` 于 2026-10-17 14:24:43 +08:00 应用；14:26 +08:00 使用独立核验的已发布 Linux launcher、真实公开 HTTPS/MCP 和官方内存会话，在两个新建合成组织（各含企业登记）、三个账号中通过 172 项检查                                                                                                           | 企业权限、管理员写入、门店/租户读取隔离、管理员无读取绕过、评分与更新语义、员工写入拒绝和坏批次原子回滚均通过；所有合成记录/会话及本轮容器、主机目录已清理 |
| 企业接入修复验收       | [PR #251](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/pull/251) 合并后，通过已部署 HTTP 和已发布 launcher，在隔离临时组织中验证企业与首店原子保存、关联审计、名称冲突与版本回滚、授权后企业候选和零数据查询；174 项脚本检查通过且清理确认                                                                                                       | 没有写入评价记录；写入工具仅做空批次拒绝验证。现有企业账号授权、类别密级、门店、业务条件部署前后逐项一致；临时组织、账号、会话、容器和主机目录已清理       |
| Skill 固定版本同步     | 本次同步将双归属核心 Skill 的当前 pin 更新为 0.12.0，并保留 standalone 的 dsh 指引；既有 [PR #76](https://github.com/YinXiaoyu-1998/smedc-mcp-skill/pull/76) 已合并                                                                                                                                                                                   | 本机 canonical 副本和已安装 launcher 未由此更新；business-analysis/delivery-ledger 配套扩展仍为 0.11.0，不在本次范围                                       |
| 管理 UI/浏览器身份     | 当前运行代码保留企业专属管理页面及浏览器会话实现；本次未重复 Device Authorization 浏览器流程                                                                                                                                                                                                                                                          | 交付某企业 URL 前仍核对其账号和租户；完整官方人工验收须独立请求                                                                                            |
| 真实企业权限           | 本次仅同步已核验的发行信息、源码推荐和使用指导，没有真实客户数据、授权、回填或平台评价回复发布                                                                                                                                                                                                                                                        | 不声明任何真实企业完成 replyStatus 启用或业务验收                                                                                                          |

0.12.0 registry shasum：`9fc830edd8825485bd07c0bbc189044614a85588`；integrity：`sha512-6uNeCtAlryZxmoCINUu4dz2VWvR6yae4qaCEPshFFAc0fuRsgPAicxoepGIUU/7G/gy+WrTqFwOaxsol+cLw+A==`。此前 0.11.0 发行和部署证据保留在 [progress](progress.md) 及 [历史记录](../history/staging-verification.md)。

此前接入修复没有新增迁移、历史补齐或真实企业权限变更；验证通过的是实际部署的保存接口、企业候选、查询及写入参数校验，没有执行真实评价落库，也没有做完整浏览器点选或官方人工全套验收。此前评价写入语义、成本卡和 Worker 清理验收证据见 [progress](progress.md)。公开包内 README 保留发行时快照，当前安装策略以核心 Skill 为准。

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
