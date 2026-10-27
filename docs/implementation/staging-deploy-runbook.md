# Staging 部署与恢复手册

当前目标和最新证据见 [staging-readiness](staging-readiness.md)。本手册描述操作契约，不授予执行授权；主机准备见 [运行前提](server-runtime-prerequisites.md)。

## 正式发布入口

正式发布通过 `.github/workflows/staging-deploy.yml` 的 GitHub `staging` Environment 执行 `npm run deploy:staging`。main 的可信质量门禁成功后部署对应不可变提交；手动 deploy/rollback 也只允许 main。PR 不部署。仅 Markdown/docs 的 main 变更跳过自动质量/部署链。

工作流使用 `smedc-staging` 并发组，保留排队发布；Action 固定提交 SHA、权限最小化，临时 SSH key 无论成功失败都删除。本地执行仅用于明确批准的恢复/工作流诊断，不能作为日常发布捷径。

## CI 构建与镜像交接

- 只有同一 PR 的新检查会取消旧检查；main、手动任务和串行 staging 发布不因此被取消。
- PR 仅修改测试或 Skill 工具时保留单元、权限和真实 MySQL/Qdrant 集成检查，跳过镜像构建；运行代码、依赖、镜像/工作流配置或未知路径仍构建。main/手动质量任务保留完整门禁。
- 三个镜像各用 GitHub Actions v2 分层缓存；缓存写入失败不跳过构建或验收，缓存不充当发布证据。main push 的镜像通过既有打包、Prisma、Calamine、PDF 检查后，导出压缩归档及 SHA/镜像 ID 清单，保留一天。同一 run 的重试可复用已测试的同 SHA 产物。
- CI 和手动发布构建均禁用 `runtime-base` 阶段缓存，worker 另禁用 `worker` 阶段缓存，确保每次构建重新获取系统安全更新及 Office/PDF 依赖；仅拉取基础镜像不会刷新已缓存的 apt 层。npm 依赖、应用与 Rust 编译继续复用缓存。系统包阶段需重新执行，构建耗时可能增加；自动部署仍复用本次质量门禁的原始镜像，漏洞检查保持阻断，不做自动豁免。
- 自动部署只下载触发它的成功 main 质量 run 的产物，验证完整提交、归档 SHA-256、三个镜像 ID、linux/amd64 和 revision 标签后，重新打不可变 ACR tag 并推送，不再构建。发布前风险扫描、迁移、smoke 和回滚保持原流程。
- 产物缺失、过期或不匹配时停止，不改用其他 run/PR 产物。需要恢复时使用获准的 main 手动部署重新构建。短期镜像归档增加 Actions artifact 存储与传输；一天保留期控制累积，不修改账单预算。
- Launcher 三平台验收与发布仅由 `smedc-mcp-launcher-v*` 版本 tag 或显式手动任务触发；普通 main push 不自动启动。版本必须匹配 package，仍先完成三平台验证和受控 staged publish，已发布版本不可覆盖。

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
2. password-stdin 登录 ACR，自动流程验证并复用质量门禁的 API/worker/release-ops 镜像；手动流程构建 linux/amd64 镜像，再对运行镜像执行当前依赖风险策略。质量工作流中的审计可见性与发布阻断策略不能混为一谈。
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

## 企业智脑官网静态产物

`apps/marketing-web` 是公开介绍与联系页面，不使用业务 API 或凭据。`npm run build:marketing` 输出 `dist/marketing`；`build:release` 同时构建该目录，现有 release-ops 镜像携带它。发布仍使用同一质量门禁、镜像交接和 GitHub `staging` Environment，不增加网站常驻服务或本地直传通道。

受控 rollout 从对应不可变 release-ops 镜像的未启动容器提取静态目录，存入 `/opt/smedc/marketing/releases/<sha>.<suffix>`，原子切换 `current` 符号链接。`previous-marketing-release` 保存之前目标；事务失败和现有 `--rollback` 同时恢复它。首次上线前若无旧页面，回滚删除 `current`，官网返回 404，API/业务页保持原契约。历史静态目录保留，不自动删除；获准清理时保留 `current` 与 `previous-marketing-release` 指向的目录。

**main 合并仍会触发现有自动发布链。** 默认只交付静态文件，不改 nginx、不申请证书、不启用公网官网。主机显式存在 `/opt/smedc/marketing-enabled` 后，rollout 才额外验证官网版本、首页、图片、HTTP/www 跳转与未知路由 404；失败进入已有回滚。静态版本变更无需 nginx reload。`version.json` 是页面代码版本校验，发布 SHA 由目录和 release-ops 镜像 tag 确定。

### 首次启用：单独授权的主机操作

以下步骤是准备说明，不是本 PR 的执行记录。只在获得官网启用、证书与 nginx 变更授权后执行；不要把含缺失证书路径的 HTTPS 配置提前装入已启用目录。

1. 核对 `smedatacenter.xyz` 与 `www.smedatacenter.xyz` 的 DNS 指向本机，80/443 可达；核对官网页尾主体“北京殷实麦家管理咨询有限责任公司”和网站备案号“京ICP备2026043481号-1”（2026-10-25 已在阿里云备案记录核实对应域名，不能用主体号省略网站序号）。验证首次受控发布已生成 `/opt/smedc/marketing/current/index.html` 与图片。
2. 备份现有 nginx 配置。保留现有 API TLS/代理块，仅将旧 default server 的 `server_name smedatacenter.xyz www.smedatacenter.xyz;` 改为 `server_name _;`（见 `deploy/staging/nginx-smedc.conf`）。不要用仓库样例覆盖 Certbot 或运维新增的有效 API 设置。
3. 创建 `/var/www/smedc-acme`，安装 `deploy/staging/nginx-marketing-bootstrap.conf` 为独立临时 enabled 配置。它只开放 ACME challenge，其余路径返回 404。先 `nginx -t`，成功才 reload；确认 API 的 health/readiness 和既有业务页面仍可用。
4. 在主机用已有 Certbot 申请同时覆盖主域与 www 的独立证书：`sudo certbot certonly --webroot -w /var/www/smedc-acme --cert-name smedatacenter.xyz -d smedatacenter.xyz -d www.smedatacenter.xyz`。按获准运维流程提供证书联系信息，不改 API 证书。核对证书 SAN 与续期任务；为成功续期配置 `nginx -t && systemctl reload nginx` 的 deploy hook。
5. 证书可用后，用 `deploy/staging/nginx-marketing.conf` 替换上述临时官网配置，不能同时启用两者。核对既有 `options-ssl-nginx.conf` 与 `ssl-dhparams.pem` 路径，`nginx -t` 成功后 reload。静态 root 只指向独立发布目录，绝不指向 runtime、业务文件或 OSS bucket。
6. 核对 HTTPS 主域首页、CSS/JS/图片；HTTP 主域与 HTTP/HTTPS www 均跳转 `https://smedatacenter.xyz/`；未知路径和 `/readyz` 返回 404。确认 `https://api.smedatacenter.xyz/healthz` 为 200、`/readyz` 为 404、未授权业务请求仍被拒绝，并检查既有权限页、台账页和 OAuth 入口。通过后创建空标记 `/opt/smedc/marketing-enabled`（root 所有），后续受控发布自动检查官网。

若首次启用检查失败，恢复备份的 nginx 配置并通过 `nginx -t` 后 reload，移除官网启用标记；不改业务授权、数据或 API 证书。配置通过与本地测试均不代表线上 TLS/路由已经验收。
