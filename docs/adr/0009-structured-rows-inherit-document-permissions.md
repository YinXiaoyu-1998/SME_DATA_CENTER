# 结构化行继承源资料权限

> **部分被取代**：ADR 0026 删除 `business` / `dishes` 结构化行；这两个数据集的当前 OSS 分区直接携带最近成功上传声明的密级，并在 manifest 生成前按组织和 clearance 授权。本 ADR 继续约束其他 row-query 数据集。

Phase 3 会把 CSV/XLSX 菜品数据和营业数据写入 MySQL 结构化行表。虽然这些行可以通过结构化 API 查询，但它们来自某个上传源文件，不能因为被规范化入表就绕过原资料的可见性规则。

**Decision**: 结构化行查询继承源 `Document` 的权限。调用方只有在有权访问产生该 `ImportBatch` 的源 `Document` 时，才能查询该批次的结构化行。`orgId` 和 dataset 只是组织和数据集范围，不是充分授权条件。后端必须先把查询限制到调用方可见的 source document/import batch，再执行过滤、排序、分页、分组和聚合。

`DishRow` / `BusinessRow` 应保留 `orgId`、`importBatchId` 和 `documentId`，以支持权限 scope、审计和追溯。Phase 3 不引入独立的行级标签系统，避免与源资料标签漂移。

**Considered Options**: 只按 `orgId` 和 dataset 授权结构化查询；为行表建立独立标签权限；复制源 document labels 到每行并作为权威权限；查询后再过滤不可见结果。

**Consequences**: 结构化数据和源文件保持同一权限边界，避免上传后扩大访问范围。聚合查询也必须先做权限 scope，防止隐藏行通过 count/sum/group 泄露。代价是结构化查询需要 join 或等价授权 scope，行表需要保留 `documentId` / `importBatchId` 并建立合适索引。
