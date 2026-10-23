# 内部权限配置 CLI

企业管理员可在权限 UI 自行配置，也可明确要求开发者代为修改。内部 CLI 是长期保留的受控运维入口，适用于类别、门店、业务条件、账号授权及普通文档属性；不依赖管理员密码、浏览器会话或 launcher token。它不开放网络监听，不增加公开 API。

## 身份与权限

- 仅获准访问服务端运行环境及数据库的开发／运维人员可运行。服务器访问权限认证实际操作者；`--operator-id` 是审计声明，不是凭据，也不证明管理员已授权。
- 每次明确指定 `--org-id` 与 `--requested-by-admin-id`。后者必须是该企业当前有效管理员；读取和保存均重新校验，保存事务内再次检查。不能以其他企业管理员代办。
- 修改还要求操作者、请求引用、原因及当前 `--expected-version`。请求引用指向受控私有工单或管理员请求；不要写密码、token 或一次性设置链接。
- 复用 UI／MCP 的业务校验和版本锁。原有管理员普通资料读取规则不因使用此 CLI 改变。

## 运行

开发环境：加载获准的本地环境后，使用 `npm run permissions:operator -- …`。发布环境使用该版本的 `release-ops` 镜像；此 CLI 随服务端发布，不需要更新 launcher。

```sh
# 在 /opt/smedc，使用正式部署留下的镜像版本和受控 runtime.env。
# runtime.env 不进入代码仓库；避免 shell 跟踪或把配置输出到日志。
set -a
. ./current-release.env
set +a
docker compose --env-file runtime.env -f docker-compose.yml --profile release run --rm \
  release-ops node dist/release/permissions-operator.js --help
```

以下示例用 `permissions-operator` 代指上面的容器命令，或开发环境的 `npm run permissions:operator --`。

```sh
permissions-operator inspect --org-id ORG_ID --requested-by-admin-id ADMIN_ID
permissions-operator inspect --org-id ORG_ID --requested-by-admin-id ADMIN_ID --section documents --search '文档标题'
```

`--section` 支持 `all`（默认）、`accounts`、`categories`、`stores`、`dimensions`、`enterprises`、`documents`、`readiness`。`all` 不计算启用准备报告；需时单独选择 `readiness`。文档每页最多 50 份，通过返回的 `nextCursor` 传 `--cursor` 继续读取。输出是权限元数据 JSON，应保存在受控位置。

## 预览与保存

1. 核对管理员请求、企业和目标，读取当前配置及 `authorizationVersion`。
2. 将单次变更写入受控 JSON 文件，或通过 `--input -` 传入标准输入（最大 256 KiB）。门店名称严格保留大小写和空格。
3. 运行 `apply` 查看预览，核对现状和完整变更。预览只读；数据库引用与业务规则以执行时校验为准。
4. 对同一输入及版本添加 `--execute`，完成一次保存；再读取当前配置确认结果。版本冲突后重新读取并核对，不自动重试。

```sh
permissions-operator apply --org-id ORG_ID --requested-by-admin-id ADMIN_ID \
  --operator-id DEVELOPER_ID --request-reference PRIVATE_REQUEST_REF \
  --reason '管理员要求停用此门店' --expected-version 7 \
  --operation store.set --input /private/change.json
# 确认预览后，对同一条命令加 --execute。
```

上例输入：`{"enterpriseKey":"EXISTING_ENTERPRISE_KEY","name":"门店精确名称","retired":true}`。不接受任意 SQL、API 路径或顶层企业／操作者／版本覆盖字段。

| 操作                                    | JSON 内容                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `enterprise.declare`                    | `name`：声明业务企业名称，服务生成企业 key；先从 `inspect enterprises` 获取结果再用于其他操作                                                |
| `store.set`                             | `name`、已有企业的 `enterpriseKey`，或新企业的 `enterpriseName`；可选 `retired`。名称与首店同事务保存；同时给 key 时必须与名称规范化结果一致 |
| `dimension.create` / `dimension.update` | `id`、`name`、可选 `retired`                                                                                                                 |
| `value.create` / `value.update`         | `dimensionId`、`id`、`name`、可选 `retired`                                                                                                  |
| `category.create`                       | `id`、`name`、`ownerships`（`group`／`store`）、`requiredDimensionIds`、可选 `retired`；仅新增普通文档类别                                   |
| `category.update`                       | `id`、`name`、可选 `retired`；固定类别还需 `confidentialityLevel`；普通文档类别还需完整 `ownerships`、`requiredDimensionIds`                 |
| `account.set`                           | `employeeId`、`clearance`（0–3）、完整 `grants`；替换该账号全部业务授权，必须保留仍需生效的原有 grant                                        |
| `account.role.set`                      | `employeeId`、`role`（严格为 `admin` 或 `employee`）；仅修改角色，保留密级、业务授权和登录身份                                               |
| `document.set`                          | `documentId`、`categoryId`、`fileConfidentialityLevel`（0–3）、完整 `scopes`；按现有规则可带 `historicalSupplementReason`                    |

`grants` 与 `scopes` 沿用现有业务权限合同。每条 grant 包含 `id`、当前 `orgId`、`enterpriseKey`、`categoryIds`、`ownership` 和 `dimensions`；门店级还需 `stores`。选择集为 `{"kind":"all"}` 或 `{"kind":"fixed","values":["精确值"]}`。每条 scope 包含 `enterpriseKey`、`ownership`、`dimensions`，门店级还需 `storeName`。维度键和值使用已有持久 ID，不使用显示名猜测。集团级与全部门店不同。

## 审计与边界

成功写入在同一事务中保存配置、版本、业务审计和操作者审计；任一审计失败则整体回滚。业务审计 `actorId` 记录提出请求的管理员，action 以 `operator.` 标明代办，并保留变更前后值。关联的通用审计使用 `permissions.operator.change`／`operator_cli`，实际员工 actor 留空，元数据记录操作者声明、管理员、原因、请求引用和版本，避免把代办伪装成管理员本人操作。已进入仓库写入逻辑的拒绝会记录拒绝审计；解析、预览和提前拒绝不宣称已保存审计。

角色变更使用独立的 `account.role.set`，不通过 `account.set` 混改角色与读取授权。例如将受控输入保存为 `{"employeeId":"EXISTING_EMPLOYEE_ID","role":"employee"}`，沿用上述 `apply` 命令的组织、请求管理员、操作者、原因、请求引用和当前版本参数，先预览，再加 `--execute`。提升与降级都要求当前有效的同组织管理员请求；执行时在原权限版本锁下重新核验。不能将最后一位未停用管理员降为 employee，返回 `AUTHORIZATION_LAST_ADMIN_REQUIRED`；停用的管理员和其他组织的管理员不计入保留人数。有另一位有效管理员时允许自行降级，降级后原账号不能再进行管理操作。

角色不会自动改变密级或业务读取授权。employee 保留原有授权范围内的查询／下载能力，但不能上传或写入店铺评价；admin 恢复管理和上传能力，普通读取仍需完整业务授权与密级。后续请求使用服务端当前角色；该操作不重置密码、不主动撤销登录会话，也不额外撤销已经签发的对象存储链接或承诺终止在途操作。

角色变更仅在受控 CLI 的不监听网络的内部路由中注册，公共管理 HTTP/UI 与 MCP 不新增改角色接口。已有 `account.set` 签名保持不变；无操作者审计上下文的普通 repository 拒绝角色变更。新 CLI 随相应服务端 release-ops 镜像交付，不需要更新 launcher。

本入口不改密码、账号生命周期、文档内容或业务数据，不提供启用／暂停、自动回填或批量事务。权限配置保存不等于企业启用；这些动作仍遵守各自授权边界。历史文档的补齐原因仅使用已有服务规则，不绕过引用校验。多条变更逐项读取新版本、逐项确认。

错误以稳定代码返回，非零退出；Ctrl+C 返回 130。若中断时保存已经开始，事务可能完成，必须先检查当前版本及审计再决定重试。CLI 不输出数据库驱动错误或连接配置。
