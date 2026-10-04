# 台账 PDF 运维与首次切换

台账以企业、精确门店名称和进货日期为一个分区。源收货单、台账行、供应商资料和检疫照片保留；刷新只替换派生 PDF 的当前指针，旧 PDF 和过期 ZIP 由已知对象键垃圾队列清理。无台账行的分区不生成空白 PDF。运行命令的系统或运维身份不会伪造员工账户。

员工 MCP 和 HTTP 均不提供 PDF 生成入口，管理员同样不能触发。导入 applied、补单或照片变化只更新对应门店/日期 revision；服务端每日北京时间 03:00 巡检统一生成新增、变化和缺失分区，健康 PDF 跳过。同一分区当天多次变化合并处理。上传成功不等于 PDF 已完成；尚未就绪时说明等待下一轮任务完成，禁止通过重复准备 ZIP 触发生成。运维 CLI 保留首次回填及恢复能力。

公共请求状态仅返回当前可读分区；失败项可带安全 `errorCode`，未知内部错误统一为 `LEDGER_GENERATION_FAILED`。`latestRequest` 仅在替代请求属于当前员工且该分区仍可读时返回，其 `status` 为该分区的替代项状态。请求所有者可以看到初始无分区请求的终态与当前已发布的 `empty` 项；隐藏分区仍按不可用处理。纯主动重绘失败且源版本、依赖授权与对象元数据未变化时，已有 PDF 继续可用。HEAD 缺少规定的 SHA-256 元数据视为异常。

ZIP 固定包含准备时捕获的精确门店/日期分区；可选取这些分区的新一代 PDF，权限变化不能把子集标为完整成功。普通中文门店名保留可读，路径特殊字符可逆转义。文件名为 `食品经营单位进货台帐_<门店>_<YYYY-MM-DD>.pdf`，检疫照片编号在每张收货单内从 1 开始。

## 环境、依赖与开关

API、worker 和 release-ops 使用同一目标企业所在的 `DATABASE_URL`、存储配置与真实 OSS `AWS_S3_PREFIX`。命令先输出不含凭证的 host/database/企业环境信息。不要在命令、日志或版本库里放数据库密码和 OSS 密钥。CLI 对远程数据库默认拒绝，明确检查目标后才使用 `--allow-remote`。

- `LEDGER_PDF_DELIVERY_ENABLED=false`：新公共 HTTP/MCP 入口默认关闭；开启后 Delivery Ledger 行明细查询和原始台账文件签发同时关闭，汇总继续可用。
- `LEDGER_PDF_RECONCILE_ENABLED=false`：首次回填期间关闭每日巡检；正式交付后须开启，它是新增和变化 PDF 的常规生成入口。
- `LEDGER_PDF_RECONCILE_TIME=03:00`：固定 `Asia/Shanghai` 时区，可配置每日时刻。
- `LEDGER_PDF_SCRATCH_ROOT=/var/lib/smedc/ledger-pdf`：worker 独占临时目录；Compose 挂载 `/opt/smedc/ledger-pdf`，主机目录必须允许镜像的非 root node 用户写入。
- `LEDGER_PDF_RENDER_CONCURRENCY=1`：单 worker 进程串行转换。多副本各有独立转换队列，应按主机 CPU/内存容量部署。

仅 worker 镜像包含 LibreOffice Calc、Noto CJK 字体、Poppler、ExcelJS 和 Sharp；API/release-ops 不安装 Office 和渲染依赖。AMD64 CI 在实际 worker 镜像里执行合成中文多页、长文本和检疫照片转换验证。不要用依赖扫描豁免替代转换验证。

## CLI：所有操作限单企业

开发入口 `npm run ledger:pdf -- <参数>`；生产入口是 release-ops 镜像内的 `node dist/release/ledger-pdf.js <参数>`。CLI 提交和读取持久化任务，实际 PDF/ZIP 由常驻 worker 处理。CLI 不需要模型调用。

```bash
# 帮助；显式列出的门店、日期可重复，按精确值去重
node dist/release/ledger-pdf.js --help
node dist/release/ledger-pdf.js refresh --org-id ORG --store '门店甲' --store '门店乙' --date 2026-10-01 --date 2026-10-02 --dry-run
# 日期范围包含首尾；默认也是 dry-run
node dist/release/ledger-pdf.js refresh --org-id ORG --store '门店甲' --start-date 2026-10-01 --end-date 2026-10-31 --dry-run --allow-remote
# 全企业全历史，仅枚举实际存在的分区；不受公共 50 店/366 天/5000 分区限制
node dist/release/ledger-pdf.js refresh --org-id ORG --all-stores --all-dates --dry-run --allow-remote
# 全门店也可限定日期，单门店也可选择 --all-dates
node dist/release/ledger-pdf.js refresh --org-id ORG --all-stores --date 2026-10-01 --dry-run --allow-remote
node dist/release/ledger-pdf.js refresh --org-id ORG --store '门店甲' --all-dates --dry-run --allow-remote
# 确认同一范围后执行；request-key 是本次操作的稳定标识，operator 是审计标签
node dist/release/ledger-pdf.js refresh --org-id ORG --all-stores --all-dates --execute --request-key first-backfill-ORG --operator 'authorized-operator' --wait --allow-remote
# 查看任务；--wait 持续等待最终状态
node dist/release/ledger-pdf.js status --org-id ORG --request-id REQUEST --allow-remote
node dist/release/ledger-pdf.js status --org-id ORG --request-id REQUEST --wait --allow-remote
# 只重试原请求的失败分区，先预览，再使用新的操作键执行
node dist/release/ledger-pdf.js retry-failed --org-id ORG --request-id REQUEST --dry-run --allow-remote
node dist/release/ledger-pdf.js retry-failed --org-id ORG --request-id REQUEST --execute --request-key retry-REQUEST-1 --operator 'authorized-operator' --wait --allow-remote
```

Dry-run 不写数据库、不上传、不渲染。执行前必须明确企业 scope、目标环境、授权运维 actor 与同一预览范围。相同操作键绑定相同范围，参数变化会冲突。内部枚举中断后用同一 request-key 重启原命令；枚举未完成的请求保持非终态，即使此前页面已全部生成。中断 `--wait` 不取消已提交任务；随后用 `status --wait` 继续。失败/部分失败返回 1，中断等待返回 130。

## 停机恢复、巡检与清理

Worker 启动时与每分钟维护时安排每日任务、清理已结束 lease 的临时目录并登记过期 ZIP。长维护周期不重叠；关机等待进行中的维护完成后断开数据库。心跳丢失或退出信号中止转换，过期租约由后续 worker 重新认领。生成与 ZIP handler 自行完成带 attempt/owner 的 fenced 状态修改，通用 worker 不重复完成任务。

巡检持久化企业/每日日期去重与分页游标，恢复最早未结束的扫描，每页最多 200 分区、HEAD 并发 4。它发现无索引、源版本变化、丢失或校验不一致的对象；健康对象只检查元数据，不重新渲染。供应商普通资料变更不会使历史 PDF 自动刷新，实际重新生成使用当时的可读供应商目录。

巡检服务的 `getReconciliationStatus(runId)` 分别返回 `scanCompleted` 和 `repairsCompleted`；扫描结束只代表发现过程结束。结合 `repairPending`、`repairFailedCount`、`repairSupersededCount` 和 `repairedCount` 判断修复结果，后来的无关手工成功不会覆盖本次巡检失败。存储 403、超时或限流是巡检错误，不当成对象丢失盲目重建。

ZIP 最多 5000 PDF、1 GiB、10 分钟，保存 24 小时；签名 URL 为 15 分钟。每轮过期维护最多登记 200 个 ZIP，**独立于巡检开关**；现有 worker 垃圾回收删除这些精确对象键。未成功上传的候选对象有持久化、租约保护的垃圾记录，结束 lease 后重复清理以应对迟到上传；不要手工清空这些记录或扫描删除整个业务前缀。只有确认当前对象之外的具体键才可人工清理。

## 发布与首次真实回填顺序

1. 完成集中 review、最终质量门禁及 worker 镜像转换检查。明确新增 Prisma archive/reconciliation/exact-key garbage 迁移、挂载、配置和人工输入。通过正式 `main` gates 与 GitHub `staging` Environment 部署后台及 CLI，两个开关保持关闭。PR 不部署；回滚恢复镜像，不回退迁移。
2. 获得 launcher 发布授权后，发布并独立验证 0.7.0，再更新服务推荐版本、两处基础 Skill pin 和 companion Skill。未发布时现有 Skill 的 0.6.0 pin 保持有效，不抢先推荐未验证版本。
3. 只在明确授权的企业内运行全量 dry-run，人工确认环境、企业、门店/日期范围和预计分区数后执行同一 CLI。缺失历史源数据、依赖扫描或转换验证未通过时保留旧路径。
4. 核对 PDF 的 11 列内容、照片、实际分区覆盖和失败重试结果后，通过正式配置部署先开启 `LEDGER_PDF_RECONCILE_ENABLED=true`，确认日常调度正常，再开启 `LEDGER_PDF_DELIVERY_ENABLED=true`；同次配置部署也可同时开启。正式交付不能长期关闭每日生成。
5. 上线验收只验证本次合成样例和获授权回填结果。发布授权不包含全套官方人工验收，也不授权其他企业回填。仅耐久发布里程碑更新 progress。

开发验证仅使用独立本地测试库与运行专属目录。加载真实本地 provider 配置后，必须先覆盖并断言 DB 为 localhost/127.0.0.1、storage 为本地专属路径，再做任何修改；此流程无需调用 AI provider。丢失恢复测试只删除当前运行生成的合成 PDF。最后删除自己创建的数据和对象，清理仓库拥有的测试资源；不删除其他项目容器或活动未合并工作树。
