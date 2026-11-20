# 手动维护套餐与读取子菜销售

本流程使用已发布并独立验证的 launcher 0.22.0。按主 Skill 的已验证安装版本安装。使用前检查连接中的工具参数和服务支持：目录工具应提供 `workbookPath`，分区下载工具应提供 `combo_sales` 和 `comboAttribution`。缺少相应能力时向员工说明需要匹配的已发布客户端和服务。普通菜品目录行继续使用现有批量接口。

| 员工想知道或维护什么                         | 取得什么数据                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “这个套餐可以选哪些菜？”                     | 用 `query_structured_dataset` 查 `dish_catalog`，限定该企业当前目录，选择 `sku_id`、`dish_name`、`dish_type`、`combo_composition`。组成字段为 JSON 文本，记录固定或可选分组及候选子菜 SKU。用同企业目录取子菜名称和规格。 |
| “昨天某店的套餐实际卖了哪些菜？”             | 先查 `describe_structured_dataset_coverage` 的 `combo_sales`，再用 `download_structured_partitions` 按返回的企业名、门店和营业日下载。原始 CSV 包含套餐、子菜、规格、数量、销售额、优惠和菜品收入。                       |
| “这些子菜收入属于哪个部门？还有多少待归属？” | 在上述范围下载中附加 `comboAttribution`，读取本地逐行归属文件。                                                                                                                                                           |
| “记住这家店这个菜名的归属”                   | 先查 `query_combo_sale_mappings`。管理员用 `update_combo_sale_mapping` 确认、更正或撤销。                                                                                                                                 |

## 管理员手动录入

- 两页菜品库用 `upsert_dish_catalog`，只传 `enterpriseName` 和原始 XLSX 的绝对 `workbookPath`。launcher 读取「总部菜品」和「总部套餐」，分批提交当前目录与组成。保存返回的批次数。遇到不唯一的 SKU 或失败批次，依据错误中的位置核对原表后重试。
- 带规格的「套餐销售统计」用 `upload_structured_dataset`。指定 `dataset: combo_sales`、准确企业名、与表内单一营业日一致的 `startDate` 和 `endDate`（YYYYMMDD）、`idempotencyKey` 及原始 XLSX 的路径文件对象。使用按门店统计、显示规格、覆盖该门店日的完整明细。取得 `partitionImportJobId` 后，用 `get_partition_import_status` 查到 `published` 再读取。重试同一提交沿用同一幂等键，修订报表用新提交替换对应门店日。

## 按部门读取实际销售

例如员工要求查询示例企业某门店一天的实际子菜收入，可在核对 coverage 后向 `download_structured_partitions` 传入以下参数。把企业和门店替换为当前授权范围中的名称。

```json
{
  "dataset": "combo_sales",
  "enterpriseName": "示例企业",
  "storeNameContains": ["示例一店"],
  "startDate": "20261120",
  "endDate": "20261120",
  "comboAttribution": {
    "evidenceStartDate": "20261101",
    "evidenceEndDate": "20261120"
  }
}
```

外层日期决定销售收入取哪几天。内层日期只决定从哪些天的同店 `dishes` 取关联菜名。门店过滤为子串匹配，回答单店问题前核对实际返回的门店。只要原始明细时省略 `comboAttribution`。

当 `attribution.status` 为 `ready`，逐行读取 `attribution.file` 指向的 JSONL。每行的 `source` 保存原始收入和规格，`attribution` 给出 SKU、部门、候选或待归属原因。多个 SKU 同属一个部门时可计入该部门一次。待归属金额单列，总额取来源的「菜品收入(元)」。保留负数和零值，避免与 dishes 中同笔套餐收入重复相加。`unavailable` 时告知员工附加读取未完成，已交付的原始分区仍可独立使用。无可读分区时报告数据覆盖情况，不能据此认定零销售。

## 权限与人工确认

套餐组成沿用本企业集团级 `dish_catalog` 授权。套餐子菜销售使用「菜品销售」(`dishes`) 的密级和同门店授权。管理员只需配置一份菜品销售权限。按部门解析还使用获准读取的菜品目录、门店映射和同店 `dishes` 关联菜名。

门店映射读取需要该企业目录及该店子菜销售两项授权，修改还需有效管理员身份。输入精确的 `enterpriseName`、`storeName`、`sourceName`、`specification` 和 `operation`。`specification` 为 null 表示该菜名的全部规格，空字符串表示明确无规格。确认时传 `operation.kind = confirm`、`basis` 和目标（`kind = sku` 配 `skuId`，或 `kind = department` 配 `departmentId`）；只在用户已确认目标时写入。更正同一身份用新的确认，撤销传 `operation.kind = revoke`。再次下载即可按当前确认读取。
