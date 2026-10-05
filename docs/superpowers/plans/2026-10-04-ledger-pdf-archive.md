# 台账 PDF 归档实施计划与完成状态

原计划日期：2026-10-04；核对更新：2026-10-05。状态：核心实施、发布、授权回填、标记巡检优化与 10:00 线上配置均已完成。本文件保存已交付的工作划分及验收依据，不是要求再次执行的任务指令。

**目标：** 按企业、精确门店名称、收货日期生成当前 PDF；员工通过四个查询/下载工具取得 ZIP；每日任务根据更新标记生成，开发者 CLI 保留全量检查和修复；关闭对外台账明细/原始源文件签发并保留汇总。

**架构：** `packages/ledger-archive/` 提供范围、来源、标记、持久任务、发布、授权及巡检；worker 使用 ExcelJS、LibreOffice、Sharp、Poppler 生成和验证 PDF，再以 fenced 短事务发布。公共 API 只查询和打包已有 PDF。基础与 companion Skill 分别维护 MCP 使用和台账工作流。

**基线：** 默认分支 `main`；当前服务实现 `1a03b74bd827`，launcher 0.7.1 已发布并推荐、最低兼容 0.6.0。线上配置 `LEDGER_PDF_RECONCILE_TIME=10:00`，时区 `Asia/Shanghai`，正式部署 `37280340186` 已生效；代码与 `.env.example` 默认仍为 03:00。

**设计：** [当前设计](../specs/2026-10-04-ledger-pdf-archive-design.md)。接口、范围、权限和运行限制以实际实现及[运维说明](../../implementation/ledger-pdf-operations.md)共同核对。

## 一、持续约束

- 业务分区为 `orgId + store_name + purchase_date`；不新增门店 ID，不修改既有收货单。
- 正文固定 `food-purchase-ledger-cn-v2` 的 11 列；当天完整有效数据加对应照片；无台账发布 empty，不生成空白 PDF。
- 员工 MCP/HTTP（包括管理员）没有 refresh/生成入口。上传 applied 或照片变化仅标记 revision，等待每日生成；准备 ZIP 不触发重建。
- 日常候选为未发布、源/发布 revision 不同、errorCode 非空；成功发布对齐 revision 并清除错误，失败或生成期间新变化保留待处理状态。
- 当前线上每日北京时间 10:00；巡检每页 200、HEAD 并发 4、持久游标及每日企业去重。代码默认 03:00 是未配置环境的缺省值。
- 开发 CLI 从 applied 有效事实与索引并集检查全历史，能发现无索引、无标记对象丢失或漏标记变化；execute 全量重建所选范围。它不受公共 50 店/366 天/5,000 分区范围限制，仍遵守每分区渲染限制。
- 供应商普通更新不触发历史重建；实际重新生成使用当时目录，所有固化来源授权继续有效。
- 发布核对 lease/generation/revision/来源；旧 PDF、候选失败和 ZIP 仅按确切对象键清理，源业务资料保留。
- 系统及 operator 任务不伪造员工；每个非 health 公共入口后端鉴权。API/release-ops 不包含 Office 或渲染器。
- 后续修改按 AGENTS.md 控制范围、测试与审查。历史实施使用过独立工作流；本文件不为未来任务强制指定代理、模型、并行或 worktree。
- 部署、launcher 发布、真实回填及官方全量人工验收各遵守当前用户授权和仓库边界，本次文档归档不增加这些行动范围。

## 二、已完成实施任务

### Task 1：固定模板与转换

- [x] `apps/worker/src/ledger-pdf/renderer.ts` 实现临时工作簿、正文/附件、转换、页数验证、超时/取消和清理；相关单元及真实转换样例已交付。
- [x] Worker 镜像包含 Calc、Noto CJK、Poppler、ExcelJS、Sharp；AMD64 CI 验证中文、长文本、多页和照片。
- [x] 限制 10,000 行、200 照片、500 MiB 照片、200 MiB PDF、180 秒转换，默认单 worker 进程渲染并发 1；超限不截断。

### Task 2：持久模型、范围与幂等

- [x] Prisma archive、来源、巡检及精确修复目标模型/迁移已落地；ProcessingRun 接入生成/打包/巡检任务。
- [x] `scope.ts`、`keys.ts`、`repository.ts`、`service.ts` 覆盖日历校验、公共范围限制、路径防碰撞/键长、分页枚举、幂等冲突与 generation。
- [x] 请求/逐项状态、empty/superseded、内部全量枚举完成标记与失败重试已实现；数据库并发和幂等回归存在。

### Task 3：完整快照、来源授权与变更标记

- [x] `types.ts` 保留精确十进制字符串；`source-reader.ts`、`supplier-values.ts`、`access.ts` 装配完整有效台账、当时供应商目录及检疫来源。
- [x] Applied、照片上传/归档及相关文档归档事务维护分区 revision 和 `affectedLedgerPartitions`；幂等回放不无故加 revision，照片先于台账可被后续快照收集。
- [x] 指纹不含最新供应商内容；实际来源/密级仍控制产物可读性，缺失或损坏照片使任务失败而非静默漏附件。

### Task 4：Worker 生成与可靠发布

- [x] `processor.ts`、`publication.ts` 及现有 worker 接入租约/心跳/重试；候选先登记垃圾保护再上传核验。
- [x] 发布短事务核对 generation、revision、来源和 lease；源变化有界重试，旧 generation 不覆盖新结果；切换 current 与旧 key 清理登记原子完成。
- [x] Empty 撤销旧 current、不删源资料；失败保留旧 PDF，源已变时不能冒充最新。临时目录与迟到候选清理受 lease 约束。

### Task 5：开发者 CLI 与部署产物

- [x] `scripts/ledger-pdf.ts`、`ledger-pdf-support.ts` 与 release-ops 编译入口交付 refresh/status/retry-failed。
- [x] 明确单企业与门店/日期选择，默认 dry-run；远端需 `--allow-remote`，execute 需 request-key/operator，支持 wait/中断恢复和逐项失败重试。
- [x] Refresh dry-run 全量枚举所选事实/索引并集、实际检查来源及 OSS HEAD，输出 needsRepair 和健康/异常/失败计数；零业务写入、零上传、零渲染。Execute 仍重建全部所选分区。

### Task 6：每日更新标记巡检

- [x] `packages/ledger-archive/src/reconciliation.ts` 只枚举未发布、revision 不同或有错误的索引候选；候选外不读取来源、不发 HEAD。
- [x] 候选逐页比较来源/文件元数据，锁内重查并提交或复用内部修复任务；StorageAdapter HEAD 区分 not_found 与检查错误，不 GET 整文件。
- [x] `(orgId, scheduleDate)` 去重、未完成扫描续跑、持久 cursor/计数及目标项统计已交付；扫描完成与修复完成分开返回。
- [x] 成功发布后下轮不再入选；失败、新源变化保留待处理状态。完全无索引或无标记历史异常由 CLI 全量检查恢复。
- [x] 线上时间已改为 10:00 Asia/Shanghai；代码默认 disabled/time=03:00 保留，正式交付开关在线上已开启。

### Task 7：授权 API、受控汇总与 ZIP

- [x] `apps/api/src/routes/ledger-pdfs.ts` 提供 coverage、status、prepare download、download URL 四入口；无公共 refresh。
- [x] 后端隔离企业并核对账号/完整来源密级；状态/计数不泄露不可读分区，operator/system 请求不通过员工接口泄露，下载绑定请求者。
- [x] 交付开关开启后禁用台账 detail/旧 cursor/源文件签发；汇总限定 store/date 与 count/countDistinct(receipt_id)/sum(purchase_amount)，其他 dataset 不变。
- [x] `bundle.ts` 固定捕获分区集合、流式 ZIP、并发替换和 stale 校验；5,000 PDF/1 GiB/10 分钟，保存 24 小时，签名 15 分钟；过期清理独立于巡检开关。

### Task 8：MCP、launcher 与 Skill

- [x] 四工具为 `describe_ledger_pdf_coverage`、`get_ledger_pdf_request_status`、`prepare_ledger_pdf_download`、`get_ledger_pdf_download_url`；打包契约没有 `refresh_ledger_pdfs`。
- [x] Launcher 0.7.0 首次发布后，0.7.1 增加业务调用 45 秒超时；版本发布/验证及后续推荐和 Skill pin 同步已完成，最低兼容仍 0.6.0。
- [x] 核心 Skill 双仓与 companion 独立仓库同步：上传确认成功 → 覆盖查询 → 等每日生成 → ZIP 准备/状态/链接。移除客户端动态台账 Excel/CSV 路径。

### Task 9：最终验证、切换与后续优化

- [x] 原始归档 PR #204 已合并；launcher 发布、同步 PR #205/#206、覆盖分页性能 PR #207、业务超时 PR #208 均完成。
- [x] 用户授权的首次回填/切换已验证内容及覆盖，并开启线上交付/巡检；该完成记录不授权其他企业回填或删除真实 PDF。
- [x] PR #209 标记筛选及 CLI 全量检查已合并部署；对应单元、真实 MySQL 回归及最终 CI 通过。
- [x] 合成三日期上传后首次检查/生成 3 个分区、第二轮 0 个；CLI 全量检查发现并修复合成对象丢失和漏标记补单，实际 PDF 包含新增内容，运行专属数据/对象已清理。
- [x] 10:00 配置通过正式部署生效，时区边界测试及运行 worker 环境均已核对，尚不包含 10 月 6 日定时执行结果。

## 三、验收依据与维护方式

| 核对项                         | 依据                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 模板、来源及发布回归           | `apps/worker/src/ledger-pdf/*.test.ts`、`packages/ledger-archive/src/*test.ts`                                                 |
| 实际候选选择、并发与发布一致性 | `reconciliation.prisma.integration.test.ts`、`repository.prisma.integration.test.ts`、`publication.prisma.integration.test.ts` |
| CLI 全量检查和零写入           | `scripts/ledger-pdf-support.test.ts` 及已完成的合成线上恢复验证                                                                |
| 公共四入口、明细关闭、ZIP 授权 | API、MCP contract、delivery/bundle 现有回归                                                                                    |
| 发布/回填里程碑                | `docs/implementation/progress.md` 的已记录历史里程碑及对应合并 PR/Actions                                                      |
| 当前日常与恢复分工             | 服务 PR #209；当前设计 §4.4 和 §8                                                                                              |
| 线上 10:00 配置                | Actions `37280340186` 与 2026-10-05 运行 worker 配置核对                                                                       |

后续实现修改只运行相关聚焦测试，最终树按仓库质量门禁完成验证；性能工作使用同一 staging 合成样例。不把纯文档整理扩大成重新发布 launcher、迁移、回填或官方全量人工验收。

后续稳定设计变更更新设计，耐久发布里程碑更新既有 progress，不在这两份文档中记录执行流水或重新开启已完成任务。
