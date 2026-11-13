# 台账 PDF 本地取件（Launcher 落盘）实施计划

**状态：** 已实现，待评审（服务 PR #352；技能 PR smedc-mcp-skill#104、smedc-companion-skills#75）。launcher 0.20.0 尚未发布，技能侧的 pin 升级留到发布验证之后。基线为 `SME_DATA_CENTER` main。本文只描述执行拆分、契约与验证入口；实现以本文和现有 `ledger-pdf-tools.md` 为准。

## 1. 目标与非目标

**目标：** 让台账 PDF 的 ZIP 像结构化分区包一样由 launcher 自己取件、校验、解压并落盘，agent 拿到的是本地目录而不是 15 分钟签名短链；此后对文件的使用不再设限。

- 新增 MCP 工具 `download_ledger_pdf_bundle`，入参仅 `requestId`；签名 URL 由 launcher 内部消费，不出现在工具结果里。
- 服务端 `POST /v1/ledger-pdfs/requests/:requestId/download-url` 响应补 `byteSize` 与 `checksumSha256`，使 launcher 能复用与分区包相同的 `downloadVerified` 校验。
- 两个技能文档改为「优先本地取件，短链兜底」，并删除「不得 fetch／不得本地文件」的绝对措辞。

**非目标：**

- 不触发、不修复、不重新生成 PDF；不改变自动更新语义与 `prepare` 的幂等规则。
- 不改变 15 分钟签名、24 小时 ZIP 保留、服务端 5,000 分区与 50 店／366 天限制。
- 不改变按人授权与每次调用重校验；不改变上传、收货单冲突、检疫证照片语义。
- 不替代 Web 台账下载中心（见 `ledger-pdf-operations.md`），两条路径并存。

## 2. 已确认的决定

| 主题       | 决定                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 工具形态   | 新增 `download_ledger_pdf_bundle`，不改 `get_ledger_pdf_download_url`（保留为「用户要自己点链接」的兜底）     |
| 完整性校验 | 服务端提供 `byteSize` + `checksumSha256`；launcher 用 `downloadVerified` 校验后再解压（与分区包、成本卡一致） |
| 上限       | 服务端真实上限：1 GiB ZIP、`LEDGER_SCOPE_MAX_PARTITIONS` 个 PDF                                               |
| 超时       | 传输预算 600 秒（与服务端 10 分钟构建期限对齐），逐块空闲超时沿用 30 秒                                       |
| 产物       | 解压后删除 ZIP，只保留解压目录 + `manifest.json`                                                              |
| 清单       | ZIP 无内置 manifest，按 `<门店>/<日期>/食品经营单位进货台帐_….pdf` 反推；门店段按百分号转义反转义             |
| 发布       | launcher 升到 0.20.0；技能以 release-gated 写法（工具存在才用），pin 在发布验证后更新                         |

## 3. 契约细节

### 3.1 服务端响应新增字段

```ts
// packages/ledger-archive/src/delivery.ts :: issueLedgerBundleUrl
{
  requestId: string,
  downloadUrl: string,
  expiresAt: ISO8601,
  byteSize: number,        // 新增：ZIP 字节数
  checksumSha256: string   // 新增：ZIP 的 sha256（小写十六进制）
}
```

- 取值来自签名前已经执行的 `storage.headObject(bundle.zipObjectKey)`（当前仅校验 `state === "found"`）：`size` 与 `hash`。
- `hash` 来自对象元数据 `smedc-sha256`，由 worker 打包时通过 `putObjectAtKey({ checksumSha256 })` 写入。
- `hash` 缺失时返回 `LEDGER_PDF_BUNDLE_STALE`（台账 bundle 均为新写入对象，缺失说明对象与记录已不一致）。
- 老 launcher 忽略新字段，向后兼容；无需数据库迁移，`commitDownloadIssue` 泛型直接透传。

### 3.2 新工具定义（`packages/mcp-contract`）

```ts
defineToolContract({
  name: "download_ledger_pdf_bundle",
  title: "Download a prepared ledger PDF bundle",
  description:
    "Download a prepared ledger PDF ZIP through the launcher into a managed local directory, verify its byte size and SHA-256, extract the daily PDFs, and return the local directory. The signed URL is consumed by the launcher and never returned. Requires launcher 0.20.0+ and the service archive capability.",
  inputSchema: downloadLedgerPdfBundleInputSchema, // { requestId: string, 1..128 }
  inputFields: [
    { name: "requestId", required: true, description: "Prepared ledger PDF request ID." }
  ],
  resultShape: [
    "localDirectory",
    "requestId",
    "fileCount",
    "files[]: relative <store>/<purchaseDate>/<pdf> paths; manifest.json is in localDirectory"
  ],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
});
```

### 3.3 返回形状与本地布局

```json
{
  "localDirectory": "/var/folders/…/smedc-ledger-extracts/extract-abc123",
  "requestId": "req_...",
  "fileCount": 7,
  "files": ["一号店/2026-11-01/食品经营单位进货台帐_一号店_2026-11-01.pdf"]
}
```

`localDirectory/manifest.json`：

```json
{
  "requestId": "req_...",
  "downloadedAt": "2026-11-13T03:20:00.000Z",
  "byteSize": 12345678,
  "checksumSha256": "…",
  "fileCount": 7,
  "files": [
    {
      "storeName": "一号店",
      "purchaseDate": "2026-11-01",
      "fileName": "食品经营单位进货台帐_一号店_2026-11-01.pdf",
      "relativePath": "一号店/2026-11-01/食品经营单位进货台帐_一号店_2026-11-01.pdf",
      "byteSize": 1763291
    }
  ]
}
```

### 3.4 错误码

| 来源       | 码                                                                                                                                                                               | 触发                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 服务端透传 | `LEDGER_PDF_NOT_ENABLED` / `LEDGER_PDF_NOT_READY` / `LEDGER_PDF_BUNDLE_STALE` / `LEDGER_PDF_UNAVAILABLE` / `LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED` / `AUTHORIZATION_VERSION_CONFLICT` | 现有语义，不重新解释                                         |
| launcher   | `LEDGER_PDF_BUNDLE_VERIFY_FAILED`                                                                                                                                                | 字节数或 sha256 与响应不一致、ZIP 结构非法、条目越界或超上限 |
| launcher   | `LEDGER_PDF_BUNDLE_DOWNLOAD_TIMEOUT`                                                                                                                                             | 超过 600 秒预算或 30 秒无数据                                |
| launcher   | `LEDGER_PDF_BUNDLE_URL_INVALID`                                                                                                                                                  | 响应缺少 `downloadUrl`/`expiresAt`/新增字段，或已过期        |

### 3.5 环境与限额

- `byteSize` 必须落在 `1 .. 1,073,741,824`；超出即 `LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED`，不开始传输。
- 临时目录 `os.tmpdir()/smedc-ledger-extracts`，复用 `cleanupStaleExtractDirectories`；解压后删除 ZIP；失败与取消时整目录回滚。
- 解压使用 `yauzl`，`strictFileNames: true`、`validateEntrySizes: true`；拒绝绝对路径、`..`、符号链接与非 `.pdf` 条目。

## 4. 分仓改动清单

### 4.1 SME_DATA_CENTER

| 文件                                                                                                | 改动                                                                                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/ledger-archive/src/delivery.ts`                                                           | `issueLedgerBundleUrl` 捕获 `headObject` 结果，响应补两字段；`hash` 缺失报 stale       |
| `packages/ledger-archive/src/delivery.test.ts`                                                      | 断言返回含 `byteSize`/`checksumSha256`；`hash` 缺失用例                                |
| `packages/mcp-contract/src/index.ts`                                                                | 新工具定义 + `downloadLedgerPdfBundleInputSchema`；加入 `SMEDC_MCP_TOOL_NAMES`         |
| `packages/mcp-contract/src/index.test.ts`                                                           | 工具清单与 schema 断言                                                                 |
| `apps/mcp-launcher/src/ledger-pdf-transfer.ts`（新）                                                | 签短链 → 有界下载（`downloadVerified`）→ 解压 → `manifest.json` → 返回                 |
| `apps/mcp-launcher/src/partition-transfer.ts`                                                       | `boundedInvocation(context, op, timeoutMs = 240_000)` 增加可选参数（不改现有调用行为） |
| `apps/mcp-launcher/src/launcher.ts`                                                                 | `createLauncherToolHandler` 增加 `download_ledger_pdf_bundle` 分支                     |
| `apps/mcp-launcher/src/ledger-pdf-transfer.test.ts`（新）                                           | 五类失败路径 + 成功路径 + 清理                                                         |
| `apps/mcp-launcher/package.json`、`src/oauth-client.ts`、`src/server.ts`、`src/packaging.verify.ts` | 版本号 0.19.0 → 0.20.0（四处必须一致）                                                 |
| `scripts/official-manual-acceptance.ts`                                                             | 核对工具清单（第 369、444 行附近）是否需要登记新工具                                   |
| `docs/implementation/ledger-pdf-operations.md`                                                      | 补「MCP 本地取件」一节与排障入口                                                       |

### 4.2 smedc-mcp-skill

| 文件                                 | 改动                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `references/ledger-pdf-tools.md`     | 工具表 4 行 → 5 行；新增「Local bundle download」小节；把「Return the short link…without fetching」改为「链接兜底 + 本地取件优先」 |
| `SKILL.md` 台账小节                  | 用户要「拿到/看看」时优先本地取件；明确 256 MiB 以上建议拆批                                                                       |
| `SKILL.md` 安装/pin 段               | 发布验证后 0.19.0 → 0.20.0                                                                                                         |
| `tests/test_smedc_skill_contract.py` | 台账工具表断言 4 → 5 行；新增「不得出现 without fetching」等回归断言                                                               |

### 4.3 smedc-companion-skills

| 文件                                              | 改动                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/smedc-delivery-ledger/SKILL.md` 第 5–7 步 | 第 7 步改为：先调 `download_ledger_pdf_bundle`；`localDirectory` 交给用户/agent 自由使用；仅在工具不可用或用户明确要链接时调 `get_ledger_pdf_download_url` |
| 同文件 Boundaries                                 | 「Do not create local ledger artifacts」收窄为「不得伪造、篡改或以本地文件替代官方台账」；删除对解压/再分发的限制                                          |
| `agents/openai.yaml`                              | 核对流程描述是否提到「只返回链接」                                                                                                                         |
| `tests/test_skill_contract.py`                    | 断言新流程措辞；保留「不得触发生成」等既有断言                                                                                                             |

## 5. 实施批次

- **B1 服务端字段：** 改 `delivery.ts` 与测试。验证：`npx vitest run packages/ledger-archive/src/delivery.test.ts`。
- **B2 契约：** 新工具定义与 `SMEDC_MCP_TOOL_NAMES`。验证：`npx vitest run packages/mcp-contract/src/index.test.ts`。
- **B3 Launcher：** 新增 transfer 模块、路由、预算参数与测试。验证：`npx vitest run apps/mcp-launcher/src/ledger-pdf-transfer.test.ts apps/mcp-launcher/src/launcher.test.ts`。
- **B4 版本与打包：** 四处版本号一致；`npm --workspace smedc-mcp-launcher run test:package`。
- **B5 技能文档：** 两个技能仓库改动 + 各自单元测试。
- **B6 联合验收：** 真实租户一次「过去一周某店」全链路；确认结果无签名 URL、PDF 数量与覆盖一致。

## 6. 测试矩阵

| 场景                              | 期望                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| 正常 7 天单店                     | `fileCount=7`，`files[]` 与覆盖分区一一对应，`manifest.json` 存在，目录内无 ZIP |
| 字节数或 sha256 不符              | `LEDGER_PDF_BUNDLE_VERIFY_FAILED`，不留半成品目录                               |
| ZIP 含 `..` 或绝对路径条目        | 校验失败，拒绝解压                                                              |
| 超过 1 GiB 或分区上限             | `LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED`，不开始传输                                  |
| 传输中断／无数据 30 秒            | `LEDGER_PDF_BUNDLE_DOWNLOAD_TIMEOUT`，目录回滚                                  |
| 取消（AbortSignal）               | 立即停止、删除临时目录                                                          |
| `download-url` 返回过期或字段缺失 | `LEDGER_PDF_BUNDLE_URL_INVALID`                                                 |
| 期间授权被收回                    | 服务端错误码透传，不落盘                                                        |
| 工具结果                          | 不含 `downloadUrl`、不含 base64                                                 |

## 7. 发布、兼容与回滚

1. 服务端先发布（仅加字段，向后兼容）。
2. launcher 0.20.0 发布并完成官方独立验证，两个技能仓库同步 pin。
3. 技能使用 release-gated 措辞：工具存在才走本地取件，否则原短链流程不变——旧 launcher 不受影响。
4. 回滚：撤回技能 pin 即可；已落盘的本地目录由 `cleanupStaleExtractDirectories` 自然过期。

**PR 拆分（每个仓库各一个）：** ① `SME_DATA_CENTER`（服务端 + 契约 + launcher + 文档）② `smedc-mcp-skill` ③ `smedc-companion-skills`。

## 8. 风险与对策

| 风险                                    | 对策                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| 1 GiB 传输超过宿主 MCP 调用超时         | 600 秒预算 + 明确超时错误码；文档建议超过约 256 MiB 按门店／日期拆批 |
| 临时盘占用达 2 GiB（ZIP + 解压）        | 先校验字节上限再传输；解压成功即删 ZIP；失败回滚目录                 |
| 传输期间权限或来源变化                  | 服务端签发时重校验 + 短链 15 分钟；launcher 不做缓存复用             |
| 再分发绕过按人授权                      | 产品已确认放开；在 companion 文档写明由用户对分发范围负责            |
| ZIP 内部结构变化                        | 严格按路径解析，不符合即报错，不做启发式猜测                         |
| 本地文件存储 `headObject` 全量重算 hash | 仅开发环境；线上 OSS 读取元数据，测试中标注                          |

## 9. 验收标准

- [ ] 真实 `requestId` 调用返回本地目录，PDF 数与覆盖一致，结果无签名 URL
- [ ] 校验、超限、超时、取消、过期五条失败路径均有明确错误码且无残留
- [ ] `npm run typecheck`、相关 vitest、launcher 打包测试、两个技能仓库单测全绿
- [ ] 技能文档不再出现「不得 fetch / 不得创建本地台账」的绝对措辞
- [ ] 旧 launcher 上行为不变（短链兜底）

## 10. 开放问题

1. 已确认：`official-manual-acceptance.ts` 只按场景调用具体工具，不枚举工具清单，无需登记新工具。

已结案：原 `ledger-pdf-download-center-implementation.md` 是 #262 的一次性执行计划，所有批次已完成且阶段规则已写在 `ledger-pdf-operations.md` §网页下载中心，因此删除该文件并从 `docs/README.md` 与 `web-frontend-migration.md` 移除引用，不再维护两套口径。
