# Staging 部署与恢复手册

当前目标和最新证据见 [staging-readiness](staging-readiness.md)。本手册描述操作契约，不授予执行授权；主机准备见 [运行前提](server-runtime-prerequisites.md)。

## 正式发布入口

正式发布通过 `.github/workflows/staging-deploy.yml` 的 GitHub `staging` Environment 执行 `npm run deploy:staging`。main 的可信质量门禁成功后部署对应不可变提交；手动 deploy/rollback 也只允许 main。PR 不部署。仅 Markdown/docs 的 main 变更跳过自动质量/部署链。

工作流使用 `smedc-staging` 并发组，保留排队发布；Action 固定提交 SHA、权限最小化，临时 SSH key 无论成功失败都删除。本地执行仅用于明确批准的恢复/工作流诊断，不能作为日常发布捷径。

## 运行拓扑

- API、worker 是非 root 常驻镜像；release-ops 是 Compose release profile 的一次性迁移、Qdrant 初始化及 fixture smoke 进程。
- 应用连接外部 RDS MySQL；Qdrant 使用独立本地卷；原件和当前分区位于批准的 OSS。
- 所有镜像来自账户所属北京 ACR。API/worker tag 为 12 位 Git SHA；release-ops 使用 API 仓库的 `ops-<sha>`，不另建仓库或凭据。
- nginx 是唯一可信代理跳：覆盖 X-Forwarded-For 为直接对端，仅 loopback nginx 地址受 API 信任；禁止 trustProxy:true。新增 CDN/LB 需单独定义代理边界。
- 公开 /readyz 返回 404，主机 loopback 才提供 readiness；公开 /healthz 提供存活检查。

## 运行配置

| 文件                                  | 来源/约束                                |
| ------------------------------------- | ---------------------------------------- |
| /opt/smedc/docker-compose.yml         | deploy/staging/docker-compose.yml        |
| /etc/nginx/sites-available/smedc.conf | deploy/staging/nginx-smedc.conf          |
| /opt/smedc/runtime.env                | 受控配置，root:root 0600；不得输出或提交 |
| /opt/smedc/current-release.env        | 发布程序记录已验证镜像引用               |
| /opt/smedc/previous-release.env       | 发布程序保存回滚镜像/Compose 对应状态    |

环境变量以 [env-inventory](env-inventory.md) 和当前 Compose/发布脚本为准。API、worker、release-ops 使用一致 DATABASE_URL、存储、Qdrant collection/检索版本及所需 provider 配置。检索版本与 collection 必须匹配；不得复制历史测试 collection 或旧 Qdrant tag。

GitHub staging secrets：ACR_PASSWORD、STAGING_CURSOR_SIGNING_SECRET、STAGING_SSH_PRIVATE_KEY；非秘密 variables：ACR_REGISTRY、ACR_NAMESPACE、ACR_USERNAME、STAGING_HOST、STAGING_SSH_USER、STAGING_PUBLIC_URL。CI 使用独立受限非交互 SSH key，并以已提交 known_hosts 严格检查主机。

## 发布顺序

1. 验证授权、main 提交及其所需质量结果，使用干净树产生不可变 tag。
2. password-stdin 登录 ACR，构建 linux/amd64 API/worker/release-ops，并对运行镜像执行当前依赖风险策略。质量工作流中的审计可见性与发布阻断策略不能混为一谈。
3. 保存前一 Compose/镜像状态，安全传输必要 secret，原子更新受控 runtime 中本次允许修改的字段；不重写其他秘密。
4. 拉取镜像，使用一次性 release-ops 执行 Qdrant 初始化和 `prisma migrate deploy`，再替换 API/worker。
5. 验证 loopback health/readiness、公开 health、公开 readiness 隔离和本次变更的关键边界。
6. 用短期正式 synthetic session 执行 fixture-only 上传/索引/搜索 smoke，撤销会话并清理 run 数据；成功后记录 current-release.env。

失败后发布程序恢复前一 API/worker/release-ops 镜像和 Compose。数据库迁移始终前向，任何镜像回滚均需兼容已应用 schema 和已启用授权；不兼容则按 [安全暂停流程](business-authorization-cutover.md) 阻断读取，不能恢复旧权限放行。

## 获准诊断或恢复

以下为受控命令形状，不是日常本地发布授权：

```bash
npm run deploy:staging -- --help
npm run deploy:staging -- --dry-run
# 显式获准后重用已有镜像；跳过迁移/smoke 必须有对应恢复理由与独立验证
npm run deploy:staging -- --tag <git-sha> --skip-build --skip-migrate --skip-smoke
npm run deploy:staging:rollback
```

`--skip-build` 仍扫描选择的镜像。不得打印临时 synthetic token、SSH key、DSN 或 runtime.env。恢复不删除 RDS/Qdrant 卷，不逆转 Prisma migration。

## 新主机与资料处理

发布脚本不创建组织/账号、不播种真实企业、不自动生成完整 runtime.env、不替代 nginx/TLS/registry bootstrap。新主机按当前运行前提、镜像配置和获准恢复方案准备；旧版本升级记录只作为历史证据，不能照搬旧 tag 或 QA 删除批准。

资料清理使用当前仓库提供的受保护 CLI，先指定环境/企业/范围并 dry-run，另行批准后执行并验证精确对象/记录清理。不得用 local-only purge-data 操作 staging，不按前缀或整集合删除客户数据。

PDF 回填和开启交付按 [PDF 运维](ledger-pdf-operations.md)；业务权限补齐/激活按 [企业切换](business-authorization-cutover.md)。这些操作与部署分别授权。完整官方人工验收也须单独请求。
