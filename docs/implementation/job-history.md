# 中央 Job 历史

Job API 首版涵盖行导入、分区导入和企业工作流运行。执行状态由既有业务服务保存。成功、失败、拒绝、取消、过期和部分完成均可查询。详细分区任务或工作流运行到期时，服务在同一事务内先写最小历史摘要，再清理详细记录。

## 接口

| 接口                                          | 请求及结果                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /v1/jobs/query`                         | `{query}`，返回 `{jobs, nextCursor}`                                                 |
| `GET /v1/jobs/{kind}/{id}`                    | 单个任务的时间、状态、摘要和带版本的管理元数据                                       |
| `PATCH /v1/jobs/{kind}/{id}/metadata`         | `{expectedVersion, reason, note?, tags?}`。`note: null` 清空备注，空标签数组清空标签 |
| `POST /v1/jobs/workflow_run/{id}/corrections` | `{type: "delivery_receipt_conflict", actionId, expectedVersion, reason}`             |

`kind` 取 `row_import`、`partition_import` 或 `workflow_run`。

| query.mode  | 必填字段                                            | 可选字段                                  |
| ----------- | --------------------------------------------------- | ----------------------------------------- |
| detail      | kind、id                                            |                                           |
| list        | kind、enterpriseKey                                 | status、startDate、endDate、cursor、limit |
| receipt     | enterpriseKey、receiptId                            |                                           |
| idempotency | kind（两种导入之一）、enterpriseKey、idempotencyKey |                                           |
| action      | workflowId、runId、actionId                         |                                           |
| actions     | workflowId、runId                                   | cursor、limit                             |

列表按创建时间及 ID 倒序，日期筛选按 UTC 创建日，单页 1–100 条。沿用同一筛选读取服务签名的 `nextCursor`。查找未命中返回空结果。单项不可见时返回 404，权限停用或账号资格不足时返回 403，输入或游标无效时返回 400，预期版本不符或更正依据不足时返回 409。

认证会话确定组织。启用业务授权的当前管理员可读本人任务；当前指定执行账号可读取接管工作流的安全汇总和当前企业、数据集及门店授权内的上传关联。领取原件、行明细或签名链接仍走相应业务权限接口。元数据变动记录操作者、原因、版本和变更前后的值。

## 自动入库与恢复

入库动作通过现有 claim/check 租约约束。上传携带 `workflowAction: {workflowId, installationId, runId, assignmentEpoch, controlVersion, actionId}`。HTTP 分区上传在 JSON 请求中携带该对象，行导入在同名 multipart 字段中携带 JSON。服务校验当前安装、授权、企业、数据集、日期、原件 SHA-256 及收货单来源门店。Job 预留和动作关联在同一事务中写入。收货单冲突先记录服务判定的旧批次关联，再返回原冲突码。动作关联支持从中央查询，客户端丢失响应后接续原 Job。

Job 到达终态后，服务保留原状态和有限错误码。绑定上传的终态失败可经既有工作流动作接口登记为 `failed/service_status`。未知结果保持待核对。换机按企业分页读取任务历史，再按轮次读取需要的上传关联。

更正验证已关轮的单日每日入库、原拒绝动作、官方冲突关联、同号同门店旧批次已入库及完整采集对账证据。服务保留原拒绝回执，更新对应门店的跳过数量。整轮范围及待核对项全部满足条件后，才更新有效汇总为 `succeeded`。详细运行已过保留期或历史缺少可信关联时，中央仍提供可用的历史摘要。

历史摘要保存业务标识、计数、状态、时间和安全错误码。已有业务存储策略管理原文件、报告、凭据和第三方业务内容。已经在部署前删除且没有中央记录的历史缺失。

## 发布

一次切换服务端、schema、launcher `0.21.0` 和每日入库工作流 `1.0.9`。MCP 新增只读 `query_jobs`，已知批次继续用专用状态工具轮询。写入使用受控 HTTP 管理接口。普通上传可独立执行，无需工作流绑定。
