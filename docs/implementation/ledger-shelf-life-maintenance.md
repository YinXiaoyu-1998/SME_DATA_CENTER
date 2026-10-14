# 台账保质期批量维护

开发侧 CLI：`npm run ledger:shelf-life -- ...`。release-ops 中使用
`node dist/release/ledger-shelf-life.js ...`。这是数据库维护工具，不是员工 MCP 工具。

## 输入

先按本次来源文件的实际格式整理成 UTF-8 JSON；CLI 不假设 Excel 的页签、列名或单位：

```json
[
  { "itemName": "加多宝", "shelfLife": "24月" },
  { "itemName": "示例食品", "shelfLife": "30天" }
]
```

`itemName`、`shelfLife` 必须是非空字符串，原文保存；不自动去空格、换算单位或模糊匹配。
品名区分大小写、全半角和前后空格。同名同值合并，同名不同值拒绝整批操作。
输入最多 2 MiB、10,000 对映射，名称/保质期最多 512/255 字符。
原始业务表和实际映射文件放在版本库之外，不提交。

## 预览与执行

数据库连接由已有安全环境中的 `DATABASE_URL` 提供，也可读取本地 `.env`。
同时提供企业 ID 和精确企业名称，服务端读取数据库核对两者；远程数据库须显式加
`--allow-remote`。工具不读取员工登录凭据，操作者应先通过官方 MCP 核对目标企业身份。

```bash
npm run ledger:shelf-life -- \
  --org-id <目标企业ID> --org-name <精确企业名称> --input /secure/mapping.json

npm run ledger:shelf-life -- \
  --org-id <目标企业ID> --org-name <精确企业名称> --input /secure/mapping.json \
  --execute --operator <操作者标记>
```

默认预览，不写入。匹配范围是该组织所有日期、所有门店的有效台账行：原始文档有效且未归档、
导入批次为已应用且未归档。归档或未完成导入的数据不参与统计和修改。

输出为 JSON，主要计数：

- `totalRows`：该企业范围内的有效台账总行数。
- `matchedRows`：品名精确命中的行数，包含保质期已经相同的行。
- `changedRows`：保质期需要改变的行数。
- `updatedRows`：实际写入的行数；预览时为 0。
- `affectedPartitions`：需要变更版本的门店/日期数。
- `unmatchedItemNames`：没有精确命中的输入品名。

## 一致性与边界

执行在同一数据库事务中取得组织级源数据修改锁，仅修改 `payload.shelf_life`，保留其他字段。
每个被修改的行写入 `audit_logs`，包含操作者标记、品名、修改前值及字段是否存在、修改后值。
受影响的门店/日期台账版本每批各增加一次；任何一步失败则整批回滚。
相同映射重复执行时不重复改值、写审计或增加版本。

CLI 只更新数据库，不生成 PDF、不提交 PDF 任务、不操作 OSS 或检疫照片。
PDF 更新由后续巡检负责。原始收货单文件不被改写。
映射只作用于执行时已有的有效行，不会成为未来导入的默认商品规则。
