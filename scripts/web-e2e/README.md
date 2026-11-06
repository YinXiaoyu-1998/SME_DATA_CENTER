# 浏览器端到端（Playwright）

覆盖真实用户路径：登录、权限设置、自动任务、台账下载中心，以及组织与角色边界。
跑的是**真实 API + 真实 MySQL + 真实构建产物**，不是组件测试的替身。

放在服务仓而不是前端仓，因为数据库、种子账号与授权边界都归服务方所有；
前端只需要提供一个构建产物目录（`WEB_DIR`）。

## 前置

1. 本地 MySQL 与 Qdrant：

```bash
MYSQL_PORT=3307 MYSQL_DATABASE=smedc MYSQL_USER=smedc \
MYSQL_PASSWORD=smedc_local_password MYSQL_ROOT_PASSWORD=smedc_local_root_password \
  docker compose up -d mysql qdrant
```

2. 迁移与种子（`MYSQL_PORT=3307`，与上面的端口一致）：

```bash
export DATABASE_URL='mysql://smedc:smedc_local_password@127.0.0.1:3307/smedc'
npm run db:migrate:deploy
npm run db:seed
npm run web:e2e:seed   # 给三个种子账号设置确定性密码
```

3. 构建前端：

```bash
(cd ../SMEDC_FRONTEND && npm run build)
```

## 运行

```bash
DATABASE_URL='mysql://smedc:smedc_local_password@127.0.0.1:3307/smedc' \
WEB_DIR="$PWD/../SMEDC_FRONTEND/dist" \
  npm run test:web:e2e
```

`run.ts` 会起 API（`127.0.0.1:3010`）、起与生产 Nginx 同构的静态站点
（`localhost:5300`，`/api/web/v1/`、`/oauth/device/`、`/auth/password/` 转发到 API），
跑完 Playwright 后一起收掉。浏览器视角始终同源，所以 `__Host-` Cookie、CSRF 与
Origin 校验走的都是线上同一套代码。

不进默认 `npm test`：它需要数据库与浏览器，属于交付前门禁而不是单元测试。

## 覆盖范围

| 文件                        | 断言                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `specs/login.spec.ts`       | 未登录跳 `/login?next=`；管理员登录后回到原路径并看到两段导航  |
| `specs/access.spec.ts`      | 员工只看到台账；员工开管理设置被拒；管理员看到两段；跨组织被拒 |
| `specs/permissions.spec.ts` | 六个区块齐全、默认选中类别密级、切换区块不跑出组织路径         |
| `specs/workflows.spec.ts`   | 从权限页切到自动任务、深链直接进入并正确高亮                   |
| `specs/ledger.spec.ts`      | 上下文加载后渲染筛选与空列表、查询后显示本批数量               |

已知未覆盖：设备授权与首次设密码两个服务端渲染页面（由 `apps/api/src/auth` 的路由测试覆盖）、
真实下载 ZIP 与 PDF 预览（需要已生成的台账产物）。
