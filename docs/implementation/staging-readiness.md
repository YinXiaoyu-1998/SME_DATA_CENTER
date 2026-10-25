# Staging 当前状态与交付前提

更新：2026-10-25。本文保留最新已核实状态、已批准目标和未完成门槛；它不是实时监控，也不授权部署、回填或企业激活。历次验证记录见 [历史记录](../history/staging-verification.md)。

## 最新核实状态

| 项目                  | 最新证据                                                                                                                                                                                                                                                         | 可得结论                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Canonical 部署        | [部署 run 40206737527](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40206737527) 成功，提交 `de2e3bfb1e9d8fd44f5c9c200cda65bb81229c6c`；对应 [main 质量门禁](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40205820080) 成功  | 三个运行镜像风险门禁、迁移检查及合成 smoke 通过；未增加漏洞豁免                                                       |
| 公开客户端策略        | 2026-10-25 部署后只读核对官方 OAuth discovery：包名 `smedc-mcp-launcher`、推荐 `0.13.1`、最低 `0.12.0`；`/healthz` 200、公开 `/readyz` 404、未认证 MCP 401                                                                                                       | 线上客户端策略不变；不替代真实租户或客户端验收                                                                        |
| npm 发行物            | 2026-10-24 官方 registry 的 `0.13.1` 与 `latest` 已公开，shasum `631cd4c10e89f546b636e066e8206a5582db7458`，源码 `775034f`；[发布 run 40064001340](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40064001340) 三平台检查成功，含 npm provenance | 独立空目录安装、CLI、48 个工具发现及六处上传 MIME schema 验证通过；生产依赖审计零漏洞；不替代客户端登录或真实租户验收 |
| 最近主机 runtime 核验 | 2026-10-25 API/worker/release-ops 为 `de2e3bfb1e9d`；loopback readiness 的 MySQL、Qdrant、storage、workerLease 和 provider 配置检查通过；runtime 文件为 root:root 0600；worker 的 libbrotli1 为 `1.0.9-2+deb12u1`                                                | 当前运行镜像与受控发布一致；不代表真实租户验收                                                                        |
| 企业智脑官网          | 2026-10-25 已启用 [官网](https://smedatacenter.xyz/)；页面 revision `7ff619b021ec8a1c` 对应已合并 PR #274/#275，页尾为北京殷实麦家管理咨询有限责任公司、京ICP备2026043481号-1                                                                                    | HTTPS、HTTP/www 301、8 项静态资源、未知路由 404、桌面/375px/320px、预约锚点/复制/FAQ 及既有业务入口检查通过           |
| 业务与客户端验收      | 2026-10-17 门店评价合成验收 172 项、企业接入修复 174 项及清理记录见 [progress](progress.md)                                                                                                                                                                      | 不替代当前真实租户授权、回填、Device Authorization 浏览器验收或完整官方人工验收                                       |

当前安装 pin 由[核心 Skill](../../skills/smedc-mcp/SKILL.md)维护；companion 的版本归属见
[三仓维护契约](smedc-mcp-skill.md)。仓库同步不等于更新员工本机安装。
公开包内 README 是发行时快照；历史发布、部署和清理证据保留在 progress 及
[历史记录](../history/staging-verification.md)，不得当作新的执行授权。

证书续期 timer 与 deploy hook 已配置；本轮 `certbot renew --dry-run` 因 Let’s Encrypt staging CA HTTPS 读取超时未完成，不能记作续期模拟通过。正式证书与生产续期端点保持有效配置。

自动发布 [run 40206323476](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/actions/runs/40206323476) 因缓存 worker 镜像中的 Brotli 漏洞在 rollout 前被阻断；上述成功部署通过既有 main 手动入口重新构建并扫描。当前 CI 系统包缓存仍可能需要同样恢复，不能靠重跑相同旧产物或跳过风险门禁放行。

## 已批准的部署目标

以下为现行运维配置入口；主机变更前按 [部署手册](staging-deploy-runbook.md) 核对目标，不能把记录值当作新的在线探测结果。

| 范围         | 配置                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官网域名     | https://smedatacenter.xyz；HTTP 与 www 301 到主域名；独立证书覆盖主域/www，有效期至 2027-01-23；Certbot timer 与 nginx deploy hook 已配置，`marketing-enabled` 后续发布检查已启用并验证 |
| 服务域名     | https://api.smedatacenter.xyz；公开 /healthz，/readyz 仅主机 loopback                                                                                                                   |
| 应用主机     | 北京轻量应用服务器 Ubuntu-yyht，实例 98872443e05742f2b64223c7462b268c，公网 39.96.66.185                                                                                                |
| 运行形态     | nginx/TLS → API；独立 worker；on-demand release-ops；本地卷 Qdrant；外部 RDS MySQL                                                                                                      |
| ACR          | cn-beijing，crpi-yyglilct3xi9outz.cn-beijing.personal.cr.aliyuncs.com，namespace smedc；API/worker 以不可变 SHA 标记，release-ops 使用 API 仓库的 ops-SHA tag                           |
| 数据库       | RDS rm-2ze2m5q387ydb9724；数据库 smedc，应用账号 smedc_app；凭据通过受控 runtime 提供                                                                                                   |
| 对象存储     | OSS oss-cn-beijing，bucket yxy-test-sme-data-center，服务前缀 smedc/；验证使用隔离测试前缀                                                                                              |
| Runtime 文件 | /opt/smedc/runtime.env，root:root 0600；当前/前一镜像记录由发布程序维护                                                                                                                 |
| 发布入口     | main 质量门禁 + GitHub staging Environment + smedc-staging 并发组；不用 PR 或未经批准的本地发布                                                                                         |
| PDF 定时     | 默认 03:00 Asia/Shanghai，可由 LEDGER_PDF_RECONCILE_TIME 配置；实际生效时刻读取目标 runtime，不沿用旧测试记录推断                                                                       |

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
