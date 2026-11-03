# Staging 当前状态与交付前提

更新：2026-11-03。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目             | 最新证据                                                                                                                                                                                                                                                                                                                                                                                                                     | 可得结论                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical 部署   | [部署 run 41582809062](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/41582809062) 与 [main 门禁 41581973665](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/41581973665) 成功；提交 `856ae837a2e8caeeba59cac98557b2c3b296a0a3`，复用同 SHA 已验镜像                                                                                                                                         | API/worker 发布镜像 `856ae837a2e8`；canonical 健康、公开 readiness 隔离及 fixture smoke 通过；官方 MCP 实际返回按 runId 的动作索引                                                                                         |
| npm 发行物       | [发布 run 41394111691](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/41394111691) 三平台通过；维护者批准后公开 `0.16.0`，来源 `8d3677dc`，shasum `0a30b1f4f186cff9e0ff70f62bc1050bf3791573`                                                                                                                                                                                                                 | 官方 registry 全新精确安装 CLI 0.16.0；全部五个文件与审阅源码构建字节一致，SDK 内存传输发现 57 项工具，工作流/订单合同与额外组织字段拒绝通过，生产 audit 零漏洞；该合同核验使用 SDK 内存传输，不冒充用户登录或真实业务验收 |
| 版本策略与 Skill | 服务 [PR #315](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/pull/315)、配套包 [PR #66](https://github.com/YinXiaoyu-1998/smedc-companion-skills/pull/66) / [#67](https://github.com/YinXiaoyu-1998/smedc-companion-skills/pull/67)、核心 Skill [PR #97](https://github.com/YinXiaoyu-1998/smedc-mcp-skill/pull/97) 已合并；companion `1.0.6`，协议仍为 `enterprise-workflows-v1` / `1.0.0`，批准 launcher 仍为 `0.16.0` | 新增兼容的服务响应字段，不新增工具或修改输入契约；原未确认动作流保留，新机可发现原轮全部状态的动作 ID 后读取最小回执；配置、授权、原件及报告边界不变                                                                       |
| 工作流迁移       | 2026-11-02 的四项工作流／来源口径迁移保留；本次另应用 `20261103043000_workflow_run_action_inventory`                                                                                                                                                                                                                                                                                                                         | 只增加按组织、工作流、runId、actionId 查询的索引；不重写业务数据、授权、历史口径或动作回执                                                                                                                                 |
| 本次边界核验     | 本地完整静态／单元门禁、真实 MySQL 十项生命周期回归，以及 main 的 MySQL/Qdrant＋fake-provider 与镜像门禁通过；外部 provider 手工门禁为 skipped；正式发布 fixture smoke 通过，官方 MCP 的新索引已只读核验                                                                                                                                                                                                                     | 未新增环境变量或 launcher 发布；服务部署、技能文件更新、宿主加载及真实任务冷启动／首轮验证仍分别核对，不能相互替代                                                                                                         |

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
- 每个客户的配置、历史补齐、明确启用及具体客户端业务验收。配置与必要历史的导入、宿主切换和真实首轮须分别验证，不能只凭 imported 标签认定完成；按[使用指南](../guides/automation-user-guide.html)先准备旧机迁移预览，再在新 Mac 检查暂停任务，明确切换后才启用。完整官方验收单独请求。

若这些事项没有新的证据，保留“未核实/待确认”，不得从历史成功、部署通过或登录成功推断完成。

## 安全核验方法

只记录非秘密的目标、时间、命令形状和结果。密码、DSN、AccessKey、SSH 私钥、token、完整设置链接、签名 URL、客户配置和原始数据不得写入本文件。

- 公开面：读取 /healthz、OAuth discovery；验证公开 /readyz 隔离和未认证业务拒绝。
- 主机：获准后检查当前镜像/提交、runtime 权限、loopback readiness、迁移与相关开关，不打印 runtime.env。
- OSS：仅对隔离测试对象做写/读/HEAD/删除，记录清理结果，不记录签名 URL。
- MySQL：使用受控凭据只读检查连接/目标，迁移、reset、清理或恢复另行授权。
- 更新时替换本文件的当前快照，将确有保留价值的旧证据放入历史记录；不要继续追加互相矛盾的“当前版本”。
