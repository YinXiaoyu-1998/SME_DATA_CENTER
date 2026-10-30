# 店内订单契约与命名迁移

当前类别为 `in_store_orders`（店内订单明细），与 `takeaway_orders` 按业务类型配对。
`order_status` 独立保存待制作、未结账、已结账、已撤单、已退单以及来源未知/空状态；结账时间和经营汇总中的结账指标保留原有含义。30 列来源及派生支付 JSON 不变，完整门店营业日包含全部状态，未结账/撤单记录允许空结账时间和 JSON null。字段及快照语义见[经营分区](structured-partitions.md)，员工操作见[店内订单 reference](../../skills/smedc-mcp/references/in-store-orders.md)。

源码候选 `0.15.0` 尚未发布。历史 `0.14.0` 使用 `settled_orders` 名称（[原始接入规格 #283](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/issues/283)）；已核验发布与环境证据保持在 [staging 状态](staging-readiness.md)。批准安装 pin、推荐值和正式人工验收运行器仍为 `0.14.0`，不能把旧客户端当作新名称支持证明。

## 前向迁移与保留边界

`20261030020000_in_store_orders` 在已有迁移之后执行，不修改旧 SQL：

- 四个数据集枚举先兼容旧/新值，迁移 `partition_import_jobs`、`structured_partitions`、`import_batches`、`import_window_claims`，再收窄为新值。物理共享表名不改；分区 ID、对象键、CSV 字节/checksum、来源及请求指纹保留。
- 固定类别更改 key，保留同一类别 ID、密级、归属、维度、退休状态与所有 grant。只更新旧默认显示名称，自定义名称保留；受影响组织授权版本递增使旧缓存/游标失效。文档元数据的明确 dataset 字段同步，审计和历史来源记录不做字符串全局替换。
- 旧下载 scope 和指纹保留为历史。旧名的排队、运行及成功 ZIP 请求变为 expired，未完成 bundle run 终止；状态可查询，新签链返回 `PARTITION_DOWNLOAD_EXPIRED`。ZIP 字节不会改名冒充新包，员工需升级后用新名称与新幂等键重新准备。
- 旧 ZIP 仅将其确切对象键登记到既有 GC，至少延迟 24 小时，保留既有已签链接 TTL。当前 CSV 不登记删除，不做真实数据回填或原件重写。
- 类别 key、分区身份、导入自然键及日期窗口出现旧/新冲突，或旧任务仍有有效运行租约时，迁移在数据更新前失败；不会覆盖或合并相撞记录。已展开的枚举可能保留，需要排除冲突后按获批迁移恢复流程继续，不能通过删除业务数据强行完成。

## 协调发布顺序

这是后续发布的前提说明，不授权执行部署或真实数据操作。

1. 发布并独立核验兼容 launcher 后，才更新双归属 Skill 安装 pin 和推荐值。当前源码仅接受新名称，旧客户端不能继续发起旧名操作。
2. 在获批维护窗口停止 API 写入和所有 worker，等待旧处理租约结束，核对备份及旧/新 key 冲突。避免新旧服务/worker 同时处理迁移中的目录。
3. 通过既有获批发布流程执行前向迁移，再启动一致版本的 API/worker，验证当前授权、旧 ZIP 的明确过期响应及新名称下载，之后恢复写入。旧上传任务 ID 与来源仍保留，可由新 worker 继续处理。
4. 旧请求指纹不重算；用新名称复用旧幂等键会冲突，新的操作使用新键。迁移只保留已有行，不证明旧快照包含全部状态；补充记录须由上传方另行授权提供完整来源。

迁移完成后不能直接恢复只认识旧枚举/类别的二进制；回滚必须另行验证数据兼容方案，不能逆改已应用迁移。无新增环境变量、订单行表或存储设施。

## 验证入口

- 官方 launcher 上传合成 XLSX → 真实 Calamine → 原子发布 → 当前权限 → 本地 CSV/JSON/ZIP：`npm run test:integration -- --in-store-orders-only`，覆盖全部五状态、未结账空字段、重复行、覆盖与失败。
- 真实 MySQL 命名升级、类别/分区冲突、授权/数据保留及旧 ZIP 过期和新下载：同一入口运行的 `packages/db/src/partition-downloads.prisma.integration.test.ts`。
- 字段/支付格式与范围传输边界继续复用 `partition-export.test.ts`、launcher `partition-transfer.test.ts` / `partition-bundle.test.ts`。环境与清理规则见 [scripts 规则](../../scripts/AGENTS.md)；源码验证不代替发布、部署或真实租户验收。
