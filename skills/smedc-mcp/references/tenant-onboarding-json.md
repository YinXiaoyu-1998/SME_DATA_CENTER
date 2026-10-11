# 内部入驻记录格式

本文件仅在开发／运维或 agent 明确需要内部记录时读取。用户通过权限设置 UI 选择与修改，不需要填写 JSON；不要主动把生成 JSON 当作入驻步骤。模板不等于服务端批量导入合同，也不承诺 UI 有 JSON 导入／导出功能。

[空白内部模板](../assets/tenant-onboarding.template.json)只存未决定项。真实填写结果、目录快照与回填清单保存在 Git 之外的私有目录，不能写回 Skill、仓库或 PR。密码、token、一次性设置链接与连接串不进入此记录。

已有企业新增账号复用当前企业规则；内部 `organizationId` 与 `enterpriseKey` 只能绑定已确认身份，`employeeId` 创建后再绑定，未确认时保留 null。角色字段用于运维开户请求或记录已有角色，不是管理员 UI 的角色变更功能。

## 字段与转换约定

`null` 表示未决定，不表示 0 级、拒绝或允许。账号数组按人数增减，每个账号单独明确授权。

| 字段                                        | 填法与含义                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `requestType`                               | `"new_enterprise"` 或 `"add_accounts"`                                                                                      |
| `enterprise.name` / `confirmIdentity`       | 企业名称；核对当前组织与业务企业对应正确后确认 `true`                                                                       |
| `levels.*.confidentialityLevel`             | 八个固定类别分别填整数 0–3；新企业全部明确，已有企业从目录预填并复用，不擅自调整                                            |
| `stores.names` / `confirmExactNames`        | 完整精确门店名列表；核对后确认 `true`，集团资料不靠门店列表定权                                                             |
| `accounts[].displayName` / `email` / `role` | 账号识别与新建请求；`role` 为 `admin` 或 `employee`，已有账号保留服务返回角色，不借填写表变更角色                           |
| `accounts[].clearance`                      | 整数 0–3，账号的读取密级上限；新 admin 的服务默认 3 不代替企业确认                                                          |
| `storeReadAccess`                           | 四类各填 `"none"`、`"all"` 或非空精确门店名数组                                                                             |
| `groupReadAccess`                           | 三类各填 `true` 或 `false`，表示是否授予本企业该类别的集团级读取权                                                          |
| `evidenceReadAccess`                        | 普通文档类别的授权条目；无需求留 `[]`，格式见下文                                                                           |
| `additionalBusinessRestrictions`            | 无其他限制时 `confirmNoAdditionalRestrictions: true`、`requirements: []`；否则填 `false` 并逐项用字符串描述项目、部门等要求 |
| `evidenceCategories` / `evidenceDocuments`  | 没有普通文档需求时留 `[]`；需要时声明类别及逐文件完整属性                                                                   |
| `historicalData.hasExistingData`            | 新的空企业填 `false`；已有资料填 `true`，再确认归属或在 `exceptions` 列出资料标识与正确归属                                 |
| `notes`                                     | 疑问、例外、需要运维核对的事项；不放密码、令牌或设置链接                                                                    |

0–3 是递增内部密级，0 级也需要业务授权，不表示公开。八个固定类别的 ownership 是业务契约，不能由填写表改动：

| 类别                                                         | 归属与读取边界                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `business`、`dishes`、`quarantine_certificate`、`ledger_pdf` | 门店级，分别授权                                                                         |
| `vip`、`dish_catalog`、`supplier_catalog`                    | 集团级，分别授权，仅限该业务企业                                                         |
| `delivery_ledger`                                            | 门店级内部生成材料，类别密级仍须明确；不生成普通读取 grant，不开放原始明细、汇总或原文件 |

`"all"` 包含该类别未来新增的门店，不包含新类别、集团资料或未来新增的必需维度。只允许当前门店时列出全部当前名称。管理员自己的普通读取也必须显式授权；所有门店类别均 `"none"`、集团类别均 `false`、文档授权为空可以表示明确的无业务读取权账号。

普通文档可使用下列填写条目；这是决策表别名，执行前必须绑定实际持久 ID：

```json
{
  "evidenceCategories": [
    { "key": "training", "name": "培训材料", "ownerships": ["store"], "requiredDimensions": [] }
  ],
  "evidenceDocuments": [
    {
      "documentIdOrPlannedFileName": "东店培训手册.docx",
      "categoryKey": "training",
      "fileConfidentialityLevel": 1,
      "scopes": [
        { "enterpriseKey": "示例企业", "ownership": "store", "storeName": "东店", "dimensions": {} }
      ]
    }
  ]
}
```

对应账号的 `evidenceReadAccess` 可填
`{ "categoryKey": "training", "ownership": "store", "stores": ["东店"], "dimensions": {} }`。
`stores` 同样接受 `"all"` 或非空数组；不授权就省略该授权条目。集团级条目使用 `ownership: "group"` 并省略 `stores`。
`requiredDimensions` 使用已确认的维度 ID；每个授权的 `dimensions` 使用这些 ID，值为 `"all"` 或非空精确值 ID 数组，文件范围则每维一个值 ID。尚未建立的额外条件先写入 `requirements`，核对支持能力与目录后再展开；不得凭名称编造 ID 或自动忽略条件。

普通文档密级逐文件明确，一份文件涉及多个门店就列出全部范围。实际文件的类别、内容范围由企业声明，不能按文件名猜测。结构化原件自动跟随成功解析的完整数据范围，不另填原件授权表。

## 使用限制

记录表达意图，不授权写入、开户、历史补齐或激活。若获准通过 MCP 配置，先读取当前目录和版本，把固定 key 绑定实际类别 ID；仅在 grant 内使用服务返回的 orgId，不供应租户覆盖参数。门店级 grant 带 stores，集团级省略 stores，所有必需维度完整。

update_account_permissions 替换整套 grant，必须保留未授权删除的既有条目；不把内部模板直接提交给 API 或 --initial-grants。版本冲突先重读，不静默覆盖。UI 上线前确有管理操作需求时，依照[当前管理工具](business-authorization.md#admin-tools)处理，不因有内部模板就要求人手填表。
