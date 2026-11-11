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

1. 校验请求形状、行数、批内 SKU 唯一、字段类型与长度、`salePrice` 规范化。
2. 锁企业身份行 `FOR UPDATE`，重查当前账号确为 admin、业务授权 `enabled`、`dish_catalog` 固定类别配置有效（复用 `upsert_store_reviews` 的护栏）。
3. 精确匹配企业名与已登记企业。
4. 一次查询解析本批所有 `departmentName`：`(org, enterprise, name IN (...), retired = false)`。0 命中返回行号；>1 命中防御性拒绝；建立 name → departmentId 映射，未提供的行写 `NULL`。
5. 幂等 upsert 该企业的目录资源与唯一集团 scope（见第 6 节），首次写入时创建，后续写入只递增 `contentVersion`。
6. 按 `skuId` 读取既有行并 `FOR UPDATE`，逐行比较规范化后的字段值：
   - 不存在 → `created`，写 `created_at = updated_at = now`；
   - 存在且任一字段（含 `department_id`）不同 → `updated`，只写 `updated_at`；
   - 完全相同 → `unchanged`，不写库。
7. 删除 `removeSkuIds` 中存在的行并计数；不存在的忽略。
8. 写一条 `AuditLog`：`action = "dish_catalog.upsert"`、操作人、`request_id`、企业、计数、`sourceFileName`、结果。
9. 提交。任一行失败整批回滚，不留下部分行。

**值保真**：不 trim、不改写大小写或全半角；`salePrice` 规范化为 canonical decimal 文本后存储，查询侧沿用 `CAST(... AS DECIMAL(20,6))`。

**并发**：行级 last-write-wins；同一 SKU 的并发写由 `FOR UPDATE` 串行化，先提交者生效。不提供 `expectedRevision`。

## 6. 读取授权与目录资源

**不新增授权模型**：继续使用 `business_resources` + `business_resource_scopes` + 既有 grant 谓词，只把目录行的关联锚点从“源文档”换成“企业”。原因是现有行查询授权按 `r.source_document_id` 关联资源（行继承原件权限），而新目录行没有源文档，这个锚点不存在；类别、密级、grant/scope 匹配规则都不变。每业务企业一份目录资源：

- `business_resources`：`kind = "structured"`、`resource_key = "dish-catalog:" + enterpriseKey`、`category_id = dish_catalog`、`valid = true`。
- `business_resource_scopes`：唯一一条，`ownership = "group"`、`enterprise_key = 企业`、`store_name = NULL`、无维度。
- 资源由第一次成功写入在同一事务内创建；后续写入只递增 `contentVersion`；删除全部行不删除资源。
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

## 11. 任务拆分、subagent 分工与规模

### 11.1 分工原则

- 每个批次只有一个写权限 owner；同一时间同一 package 只有一个写者。
- 修改文件的 agent 使用独立 worktree/branch；reviewer 只读，不写文件。
- 契约先行：`packages/domain` 的 registry/类型和 `packages/mcp-contract` 的 schema 冻结后，下游批次才并行，避免接口反复。
- 共享文件指定唯一 owner：prisma schema、mcp-contract 工具清单、server 装配、structured-query 路由。其他批次需要改动时提交给 owner，不直接改。
- 每批完成标准：实现 + 对应测试 + 受影响契约描述 + 自审；不接受“先合并后补测试”。
- 只在 C1 结束做一次契约检查（类型/字段/SQL 形状），最终做一次合并 review；不逐小批 review。
- 最终整树只跑一次全量门禁（`format:check`、`lint`、`typecheck`、`test`），失败才重跑。

### 11.2 批次与 owner

| 批次 | 范围（包/模块）                                      | owner 交付物                                                          | 依赖                  | 生产/测试规模         |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------- | --------------------- |
| A1   | `packages/mcp-contract`、`packages/web-api-contract` | 新错误码 `DIRECTORY_DUPLICATE_NAME`、目录工具描述、契约测试           | 无                    | +40 / +50             |
| A2   | `apps/api` 员工目录服务                              | create/rename 同名校验、首尾空白拒绝、服务测试                        | A1                    | +60 / +80             |
| A3   | `packages/db`                                        | 部门唯一索引迁移、重复预检、集成测试                                  | 无（schema owner）    | +30 / +60             |
| A4   | 只读 review                                          | 复核 A1–A3 的授权、事务与迁移                                         | A1–A3                 | —                     |
| B1   | `SMEDC_FRONTEND`                                     | 部门表单本地校验、409 行内错误、契约再生成、组件测试                  | A 合并                | +80～120 / +60～100   |
| C1   | `packages/domain`                                    | `current` 元数据、目录字段/校验、查询 join、coverage 类型、编译测试   | A 合并                | +350～450 / +300～380 |
| C2   | `packages/db`、prisma                                | 新表迁移、写入仓库、目录资源/scope、部门解析、集成测试                | C1、A3                | +300～380 / +250～320 |
| C3   | `apps/api` 查询/coverage                             | `catalog` 读取授权、coverage 仓库、路由接线、授权测试                 | C2                    | +120～160 / +150～200 |
| C4   | `apps/api` 写入、`packages/mcp-contract`             | 服务/路由、`upsert_dish_catalog` schema 与描述、server 装配、测试     | C2、C1                | +250～330 / +250～320 |
| C5   | 旧链路清理                                           | structured-import 拒绝、upload-tools、worker、launcher bump、打包断言 | C4                    | −350～−500 / +80～120 |
| C6   | 文档                                                 | README、api-contract、data-pipelines、本仓 Skill 章节                 | C5                    | +200～300             |
| C7   | 只读 review                                          | PR-C 合并 review（授权、事务、SQL、错误码）                           | C1–C6                 | —                     |
| D1   | `smedc-mcp-skill` + 本仓 pin                         | 双仓 Skill 重写、launcher 核验后更新 pin                              | C 合并、launcher 发布 | +120～180 / 同步测试  |

A 组合计约 +130～180 / +190～240；C 组合计约 +1000～1400 / +800～1100；B、D 单独统计。`package-lock.json` 不变。

### 11.3 依赖与并行

```text
A1 ── A2 ─┐
A3 ───────┼── A4 ── 合并 A ── B1（前端，可与 C1 并行）
          │
C1 ── C2 ─┼── C3 ─┐
          │        ├── C5 ── C6 ── C7 ── 合并 C ── D1
          └── C4 ──┘
```

- C3 与 C4 只有在前者不碰 server 装配、后者不碰查询路由时可并行；若共享文件出现冲突，按 C3 → C4 串行。
- C5 依赖 C4 冻结的契约（上传枚举、错误码），不与 C3/C4 并行修改 `mcp-contract`。
- D1 必须在 launcher 发布并核验之后，避免 Skill 指向未发布契约。

### 11.4 每批验收

- 通过该批次的最小聚焦测试，并在交接里写明命令与结果。
- 契约变化同步到 MCP 描述、错误码和文档；不留 TODO、占位符或“稍后补测试”。
- 自审 diff：只改本批 owner 范围；跨范围改动先交接。
- C7 之后只做合并、发布和 Skill pin，不再改代码。

## 12. 测试面

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
