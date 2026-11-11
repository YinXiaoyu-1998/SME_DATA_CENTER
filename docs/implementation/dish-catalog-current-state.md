# 菜品目录当前状态与部门名称唯一

状态：2026-11-11 源码已实现并通过聚焦测试，**未部署、未激活真实企业**。规格（权威入口）：[Issue #337](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/337)。决策记录见 [ADR 0029](../adr/0029-dish-catalog-current-state.md) 与 [ADR 0030](../adr/0030-department-name-uniqueness.md)。本文件是实现边界与验收依据，不表示已经部署或可用于真实企业。

## 1. 范围

**本次包含**

- `dish_catalog` 从追加式快照改为每业务企业一份当前目录。
- 新增 MCP 工具 `upsert_dish_catalog` 与 HTTP `POST /v1/dish-catalog/upsert`，批量维护行。
- 新增可空 `department_id`，引用企业部门目录；写入按名称解析，读取返回当前名称。
- 目录行改为按“类别授权 + 企业范围”读取，不再继承源文档权限。
- 删除菜品目录的文件上传与解析链路，硬切旧数据。
- 查询字段与 coverage 形态调整。
- 部门名称在同一业务企业内唯一（后端 + 前端）。

**明确不做**

- 历史快照迁移、双写、兼容开关、旧 launcher 兼容。
- 按部门授权（部门只是分类字段，不进入业务授权维度）。
- 行级变更审计、删除恢复、目录级 `revision`。
- 其它数据集的任何文件解析或上传行为改动。

## 2. 领域模型

| 术语         | 含义                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| 菜品目录     | 每个业务企业一份当前菜品清单，`(org, enterprise, sku_id)` 唯一，一行一个 SKU |
| 菜品部门归属 | 目录行以稳定部门标识引用企业部门目录中的部门；可空                           |
| 目录写入批次 | 一次 `rows` + `removeSkuIds` 提交，整批原子                                  |

字段是权威值：省略可空字段表示清空，不等于保留旧值。

## 3. 公共契约

### 3.1 MCP `upsert_dish_catalog`

输入（严格对象，拒绝未知键）：

| 参数             | 类型     | 必填 | 约束                           |
| ---------------- | -------- | ---- | ------------------------------ |
| `enterpriseName` | string   | 是   | ≤255，精确匹配本组织已登记企业 |
| `rows`           | array    | 否   | 与 `removeSkuIds` 合计 1–1000  |
| `removeSkuIds`   | string[] | 否   | 同上，元素 ≤128，批内不重复    |
| `sourceFileName` | string   | 否   | ≤255，仅审计用，服务端不读文件 |

行字段：

| 字段                 | 类型   | 必填 | 约束                                         |
| -------------------- | ------ | ---- | -------------------------------------------- |
| `spuId`              | string | 是   | ≤128                                         |
| `skuId`              | string | 是   | ≤128，批内唯一                               |
| `dishName`           | string | 是   | ≤512                                         |
| `brandName`          | string | 是   | ≤255                                         |
| `baseCategoryName`   | string | 是   | ≤255                                         |
| `level1CategoryCode` | string | 是   | ≤128                                         |
| `level2CategoryCode` | string | 否   | ≤128                                         |
| `specificationName`  | string | 否   | ≤255                                         |
| `salePrice`          | string | 是   | 十进制文本，`^\d{1,14}(\.\d{1,6})?$`，允许 0 |
| `dishAlias`          | string | 否   | ≤512                                         |
| `departmentName`     | string | 否   | ≤255，精确匹配该企业未停用部门               |

- 写入只接受部门**名称**，由服务端解析为稳定 ID；不接受部门 ID，避免两套寻址。
- 整个请求 UTF-8 JSON ≤16 MiB；`rows` 与 `removeSkuIds` 合计超过 1000 返回 `DISH_CATALOG_BATCH_TOO_LARGE`。
- 同一 SKU 同时出现在 `rows` 与 `removeSkuIds` 返回 `DISH_CATALOG_SKU_CONFLICT`。
- 注解：`readOnlyHint: false`、`destructiveHint: true`、`idempotentHint: true`。

输出：`{ received, created, updated, unchanged, removed }`。`received = rows.length + removeSkuIds.length`；`created + updated + unchanged = rows.length`；`removed` 只计实际删除行，不存在的 `removeSkuIds` 视为无操作。

错误码：

| 错误码                                                           | HTTP | 说明                                                      |
| ---------------------------------------------------------------- | ---- | --------------------------------------------------------- |
| `DISH_CATALOG_INVALID_INPUT`                                     | 400  | 字段、长度、小数或批次结构不合法；`rowIndexes` 最多 50 个 |
| `DISH_CATALOG_DUPLICATE_SKU`                                     | 400  | 批内 SKU 重复                                             |
| `DISH_CATALOG_SKU_CONFLICT`                                      | 400  | 同一 SKU 同时写和删                                       |
| `DISH_CATALOG_DEPARTMENT_NOT_FOUND`                              | 400  | 部门不存在或已停用；`rowIndexes` 最多 50 个               |
| `DISH_CATALOG_DEPARTMENT_AMBIGUOUS`                              | 400  | 防御性兜底；唯一性生效后不应出现                          |
| `DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE`                          | 400  | 企业名不在本组织已登记范围内                              |
| `DISH_CATALOG_BATCH_TOO_LARGE`                                   | 400  | 行数或删除数超限                                          |
| `UPLOAD_ADMIN_REQUIRED`                                          | 403  | 非 admin                                                  |
| `AUTHORIZATION_NOT_ENABLED` / `RESOURCE_CATEGORY_NOT_CONFIGURED` | 403  | 沿用现有业务授权检查                                      |
| `DATASET_UPLOAD_RETIRED`                                         | 400  | 旧上传入口收到 `dish_catalog`                             |
| `PAYLOAD_TOO_LARGE`                                              | 413  | 请求体超过上限                                            |

### 3.2 HTTP

`POST /v1/dish-catalog/upsert`，请求与响应同 MCP；`cache-control: no-store`；JSON 解析沿用 `upsert_store_reviews` 的严格解析方式，错误详情只回显固定字段名和有界行号。

### 3.3 查询

`query_structured_dataset` 继续支持 `dish_catalog`，字段：`spu_id`、`sku_id`、`dish_name`、`brand_name`、`base_category_name`、`level_1_category_code`、`level_2_category_code`、`specification_name`、`sale_price`、`dish_alias`、`department_id`、`department_name`、`created_at`、`updated_at`。

- `department_id` 来自行表列，`department_name` 由 `LEFT JOIN business_departments`（按 `department_id` 主键）得到当前名称；两者都可过滤、排序、分组、聚合。
- 默认排序 `sku_id ASC`，保证游标分页稳定；显式排序沿用现有唯一 tiebreaker 规则。
- 默认返回 `department_name` 和 `updated_at`，默认不返回 `created_at` 与 `department_id`；显式选择时均可返回。
- 查询与 coverage 只返回当前账号获准的集团级企业；未授权企业不出现行数或时间。

### 3.4 coverage

`describe_structured_dataset_coverage` 对 `dish_catalog` 返回 `{ rowCount, lastUpdatedAt }`：`COUNT(*)` 与 `MAX(updated_at)`，作用域与查询相同，不再是按快照的来源列表。

## 4. 数据模型

```text
dish_catalog_entries
  id             varchar(32)  PK
  org_id         varchar(64)
  enterprise_key varchar(128)
  sku_id         varchar(128)
  department_id  varchar(36)  NULL  -- FK business_departments.department_id
  payload        json          -- 十个目录字段
  created_at     datetime(3)
  updated_at     datetime(3)
  UNIQUE (org_id, enterprise_key, sku_id)
  INDEX  (org_id, enterprise_key)
  INDEX  (department_id)
  FOREIGN KEY (department_id) REFERENCES business_departments(department_id) ON DELETE RESTRICT
```

- 部门名称不落库，读取时按 `department_id` 关联；部门改名、恢复都不影响已写入行。
- 删除 `dish_catalog_rows`。旧 `ImportDataset.dish_catalog` 枚举值保留但不再产生新批次，避免破坏性 DDL 和遗留 OSS 引用；上传入口在产生任何副作用前拒绝。
- `business_departments` 增加 `UNIQUE (org_id, enterprise_key, name)`。
- 迁移不含任何数据回填；旧目录数据直接丢弃。

## 5. 写入语义

单个数据库事务，顺序固定：

1. 校验请求形状、行数、字段类型与长度，并规范化 `salePrice`。
2. 锁定组织授权状态，复核当前账号为有效 admin、业务授权已启用、固定类别可用。按登记原值匹配企业名并锁定企业身份。
3. 按 SKU 唯一索引使用的 MySQL 排序规则检查批内重复与写删冲突。按部门列排序规则在当前企业的有效部门中解析 `departmentName`，并把无法解析的行号返回给调用方。
4. 锁定既有 SKU 行并比较内容。插入写入创建及更新时间，更新只刷新更新时间，内容相同则保留既有行。
5. 删除显式列出的 SKU 并计数，忽略不存在的 SKU。目录发生变化时，在同一事务中维护目录资源及集团 scope，并推进用于游标失效的授权版本。
6. 记录一条批次审计并提交。相同内容的重放仅增加审计，不刷新行时间、资源版本或查询游标。任一行失败整批回滚。

**值保真**：不 trim、不改写大小写或全半角；`salePrice` 规范化为 canonical decimal 文本后存储，查询侧沿用 `CAST(... AS DECIMAL(20,6))`。

**并发**：行级 last-write-wins；同一 SKU 的并发写由事务锁串行化，后提交的内容生效。不提供 `expectedRevision`。

## 6. 读取授权与目录资源

**不新增授权模型**：继续使用 `business_resources` + `business_resource_scopes` + 既有 grant 谓词，只把目录行的关联锚点从“源文档”换成“企业”。原因是现有行查询授权按 `r.source_document_id` 关联资源（行继承原件权限），而新目录行没有源文档，这个锚点不存在；类别、密级、grant/scope 匹配规则都不变。每业务企业一份目录资源：

- `business_resources`：`kind = "structured"`、`resource_key = "dish-catalog:" + enterpriseKey`、`category_id = dish_catalog`、`valid = true`。
- `business_resource_scopes`：唯一一条，`ownership = "group"`、`enterprise_key = 企业`、`store_name = NULL`、无维度。
- 首次实际写入菜品时在同一事务内创建资源；后续目录变化推进 `contentVersion`；删除全部行保留资源。
- 读取新增 correlation target `catalog`：`ar.kind = 'structured' AND ar.org_id = r.org_id AND ar.resource_key = CONCAT('dish-catalog:', r.enterprise_key)`，随后复用既有 resource/scope/grant 谓词。
- 没有资源、类别未启用或授权不符时**失败关闭**：查询返回 0 行，coverage 返回 0 / null，不回退到文档密级或客户端过滤。
- 写入需要 admin，不因此获得普通读取权；读取仍需 `dish_catalog` 类别授权与对应企业范围。

## 7. 部门一致性与改名

- 部门改名：目录行不变，读取按 ID 关联得到新名称；不需要级联、不会错绑。
- 部门停用：已有行继续正常显示名称；再次写该行时必须改为未停用部门或置空。
- 部门恢复：名称不变，无需处理。
- 目录写入不自动创建部门；缺部门时返回 `DISH_CATALOG_DEPARTMENT_NOT_FOUND`，提示先维护部门目录。

## 8. 部门名称唯一

**后端**

- `manage_department` 的 `create` 与 `rename` 在同一事务、同一企业锁内检查全状态同名；冲突返回 `DIRECTORY_DUPLICATE_NAME`（409）。
- 名称首尾空白直接拒绝创建/重命名，不静默 trim。
- 数据库唯一索引作为最后防线；迁移前用预检 SQL 找重复，存在重复时人工处理后再执行迁移。
- 契约：`packages/web-api-contract` 错误码联合类型加入新码；MCP `manage_employee_directory` 的描述同步。

**前端（`SMEDC_FRONTEND`）**

- 部门创建/重命名表单：空值、首尾空白、与当前企业现有部门同名时本地拦截。
- 服务端 `DIRECTORY_DUPLICATE_NAME` 映射为名称字段行内错误，沿用现有双语文案与冲突处理方式。
- 从 `web-api-contract` 重新生成前端契约；门店创建流程不动（`BusinessStore` 主键已保证唯一）。

**预检 SQL**

```sql
SELECT org_id, enterprise_key, name, COUNT(*) AS duplicates
FROM business_departments
GROUP BY org_id, enterprise_key, name
HAVING duplicates > 1;
```

## 9. 删除项

- `upload_structured_dataset`：`dish_catalog` 从可上传数据集移除；旧客户端调用返回 `DATASET_UPLOAD_RETIRED`。
- `POST /v1/structured/imports`：在产生 Document / ImportBatch 前拒绝 `dish_catalog`。
- worker：删除 catalog 解析、行写入、归档删除分支。
- `packages/domain`：删除 catalog 专用表头/sheet 校验与 `snapshotDate` 分支；`sheetPolicy` 增加 `"none"`，`metadataPolicy` 增加 `"current"`，`inputSource` 增加 `"api"`；行存储映射增加物理列与部门关联。
- launcher：打包/契约断言里移除上传枚举中的 `dish_catalog`，保留查询枚举；按契约边界 bump launcher 版本。
- 文档与 Skill：`README.md` / `README.zh.md` 的菜品目录章节已改为当前状态与批量写入；本仓 `skills/smedc-mcp` 已改写。独立仓 `smedc-mcp-skill` 与 pin 在 launcher 发布后按 #345 处理。

## 10. 发布顺序

1. 部门名称唯一（后端）→ 部署。
2. 前端表单与契约再生成 → 部署。
3. 菜品目录服务端 + launcher 版本 bump → 部署服务、发布并核验 launcher。
4. 双仓 Skill 与 pin 更新（launcher 核验后）。

硬切，不保留过渡期；旧 launcher 在目录上传时得到明确拒绝，不影响其查询与其它数据集上传。

## 11. 测试面

- **domain**：字段/长度/小数/空值语义、批内重复、写删冲突、上限、规范化 decimal；registry 的 `current` 元数据、物理列与部门关联字段；查询编译的 join、默认排序、过滤/分组/聚合。
- **db（Prisma 集成）**：创建/更新/不变/删除计数；`unchanged` 不刷新时间戳；部门缺失、停用、歧义；企业名不匹配；非 admin；授权未启用；并发同 SKU 写；审计一条；唯一约束冲突；`department_id` 外键拒绝悬空引用。
- **授权**：无 grant 返回 0 行；企业 A 的 grant 读不到企业 B；类别停用/未启用失败关闭；admin 无 grant 不能读；目录资源与集团 scope 只建一次；coverage 口径一致。
- **api 路由**：403、400（有界行号）、413、成功计数、旧上传拒绝且无副作用、查询字段与默认排序、改名后读取到新名称、停用部门仍可读。
- **MCP/launcher**：工具 schema、注解、上传枚举排除、查询枚举保留、版本与打包断言。
- **worker**：确认不存在 `dish_catalog` 作业路径，上传被路由前拒绝。
- **前端**：部门表单本地校验、409 错误映射、契约再生成。
- **文档/Skill**：链接与示例对照当前 schema；双仓同步测试。

## 13. 风险与已知限制

- 无历史快照：无法回溯“某日菜单”，需要时由调用方写入前留存。
- 硬删除不可恢复；审计只有计数。
- 游标分页与其他行查询数据集一致，翻页期间的并发写可能造成漏行或重复，调用方以 `sku_id` 去重。
- 查询 join 与目录资源是新代码路径，必须由授权测试覆盖；join 只允许开发登记的固定关联，不接受客户端表名/列名。
- 部门改名对读取透明，但调用方缓存的旧名称会解析失败；智能体应重新读取部门目录。
- 目录资源不随行删除而删除，coverage 以 0 行表示“已授权但暂无目录”。
