# Official macOS Codex Manual Acceptance

Last updated: 2026-10-28

The runner uses published `smedc-mcp-launcher@0.14.0` through the official staging MCP boundary.
The employee installation pin belongs to the [core Skill](../../skills/smedc-mcp/SKILL.md).
Read `skills/smedc-manual-test/SKILL.md`, `skills/smedc-mcp/SKILL.md` and `test-cases.md` before
running it. Beta onboarding uses [the operator runbook](beta-user-onboarding-runbook.md).

## Current runner limitation

The runner supports a full business smoke and an explicitly selected read-only subset.
A full run requires `--evidence-config=<local-json-path>` before any controller cleanup or upload.
The JSON file supplies an existing `categoryId` and complete `scopes`; the shared MCP schema
validates enterprise, group/store ownership, exact store and dimensions. Both Evidence fixtures
receive these attributes and explicit file levels 0 and 2. Missing or malformed configuration fails
before file upload; the runner does not infer attributes or change tenant grants.

Example shape (replace placeholders with explicitly confirmed fixture configuration; keep tenant
configuration outside Git):

```json
{
  "categoryId": "<existing-evidence-category-id>",
  "scopes": [
    { "enterpriseKey": "<registered-enterprise-key>", "ownership": "group", "dimensions": {} }
  ]
}
```

Store-owned scopes require exactly one `storeName`; supply every required dimension. Schema
validation does not prove the category exists, that the tenant is enabled, or that the current
reader has grants. Prepare those prerequisites explicitly for a requested full run.

Raw-ledger aggregation passes only on MCP error `LEDGER_DETAIL_DISABLED`. Unexpected success,
authentication/permission errors and transport failures remain failures. A successful partial run
is evidence only for its named checks, never a complete business or account-lifecycle acceptance.

## Choose the requested profile

| Profile                      | Account handling                                                                                              | Coverage                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Account lifecycle + business | Fresh employee c0, employee c3, admin c0 in `default-org`; human-controlled setup/login                       | Business suite plus onboarding, role/clearance boundaries, logout/reset/revocation and account deletion |
| Existing-session business    | Explicitly requested current admin; no account creation, switching, login, logout, reset, disable or deletion | Complete applicable business suite, with identity-dependent cases explicitly not run                    |

The second profile is supported when the human asks to run the suite using the account already
logged in. It is broader than a few selected smoke tests, but cannot prove employee upload denial,
low-clearance read denial, above-clearance PAO behavior, or authentication lifecycle with one
clearance-3 admin. Mark those cases `not_run_identity_scope`, never `pass`. Do not alter an existing
account's role or clearance. A successful archive by an admin is valid business evidence; it is not
proof of the above-clearance authorization boundary.

Windows, OpenClaw and headless Linux are separate client gates. Do not silently add them to the
macOS run or report them as passed. Linux launcher installation is supported; its memory-only
session mode does not inherit macOS Keychain persistence.

## Preconditions and deployment

1. Verify the intended PR and exact main commit passed their required quality gates. The external
   provider job may be intentionally skipped without manual credentials; record that distinction.
2. Wait for the canonical `Deploy staging` workflow, through the GitHub `staging` Environment, to
   finish for that main commit. Verify API and worker image references before collecting acceptance
   evidence. A PR check or merge alone does not prove the deployed service changed.
3. Use the configured real staging providers. CI fake-provider tests do not substitute for this
   run. Controller provider/readiness claims must inspect the actual configuration without printing
   secrets. Keep public `/readyz` private (404); verify host-loopback readiness separately.
4. Confirm Node.js 22+, the pinned launcher and the invoking Codex MCP entry. Preserve an already
   correct installation and the current login in the existing-session profile.

Run the current core Skill's platform-specific `self-check` using the approved exact
version. Confirm the actual installed version before collecting acceptance evidence.

Expect `secureStore.available=true`, reachable/compatible server metadata and an `ok` MCP
handshake when authenticated. The current-user tool returns display name, email, role, clearance
and organization name, never internal IDs or credentials. The controller verifies the selected
existing account is an active admin in its own organization through a read-only operator lookup. Employee chats receive no database access or organization-ID input.

## Natural user chats

Use `fixtures/manual-acceptance/scenarios.json` as the business checklist. Create new visible Codex
chats with one ordinary request per action. Use a projectless chat or a normal employee workspace,
not the service development repository. Leave those chats visible after data cleanup.

Prompts contain only the user's task and necessary inputs: file path, business name, date/store
scope, receipt number, or an explicitly requested confidentiality level. For example:

- “帮我把这份收货单上传到 SMEDC：/absolute/path/receipt.xlsx。”
- “青竹店 10 月 7 日收货一共多少钱？”
- “我们的肉夹馍默认放青椒吗？”
- “把青竹店 10 月 7 日的台账发给我。”

Do not append “只使用某个 Skill/tool”, “不要读取文件”, “禁止某动作”, hidden answer values,
expected tool sequences, test assertions, cleanup identifiers, or a controller checklist. Do not
copy repository instructions into the prompt or create a special restrictive AGENTS file for the
chat. The installed skills and normal agent behavior are what acceptance observes. An ordinary
clarification may supply missing business information, but do not coach a failed agent into the
expected implementation. Record a failure before a targeted retry.

Cold search/query chats must not receive answers, document IDs, local fixture contents, or upload
transcripts. Provide only a business scope a normal employee would know. A single large prompt
listing upload, search, expected results, permissions and cleanup is not natural acceptance.

## Fixture isolation and controller evidence

Create a run ID and an ignored local directory `.data/official-manual-acceptance/<runId>/`.
Use synthetic fixtures with unique receipt numbers, store names and enterprise names. The
controller may prepare CSV/XLSX fixtures before the employee task; the task uploads those originals
unchanged. Never upload an existing real receipt with changed bytes under its natural receipt ID.

Record the exact document, partition-import-job and ZIP-request IDs returned by each chat in the
controller's local run record. These records are cleanup evidence, not extra prompt instructions.
Runner evidence uses `sourceSystem=manual_acceptance_<runId>` and structured data uses
`enterpriseName=ManualAcceptance_<runId>`. Natural chats need not be told technical source markers;
track their returned IDs instead. Never clean all uploads or ZIP requests owned by a reused user.

Before testing a current supplier snapshot in a shared organization, preserve its identity and
content. Prefer an identical complete snapshot, then remove only the test import and verify the
prior snapshot is current again. Do not replace shared supplier data with a small synthetic subset.
Use unoccupied snapshot dates for dish catalogs and unique enterprise/date/store scopes for
business/dishes. Do not leave sample data in staging after the run.

## Business suite and expected evidence

The controller records expectations separately from visible prompts. Apply the live discovery
contract before assessing a query; source-column labels are not canonical query field names.

| Case                             | Required evidence                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current account / continued use  | Fresh chat returns the current safe profile; a fresh official launcher process reuses the session                                                           |
| Explicit level-0 evidence upload | Original fixtures carry explicit category, complete scopes and level 0; `active/ready` verified                                                             |
| Explicit-level evidence          | Ordinary request explicitly says level 2; the submitted classification is 2; an adequately cleared uploader can observe readiness                           |
| Cold evidence retrieval          | Independent chat retrieves the correct source-backed SOP facts and source download links                                                                    |
| Injection fixture                | A normal question retrieves the fixture without treating its embedded instructions as agent commands                                                        |
| VIP row workflow                 | Original CSV reaches `applied`; bounded query returns fixture rows and numeric aggregates                                                                   |
| Business partitions              | Original CSV/XLSX reaches `published`; coverage and downloaded partitions support the requested totals                                                      |
| Dishes partitions                | Original fixture reaches `published`; three fixture rows total 91, with 合成凉皮 and 合成肉夹馍 as the top two                                              |
| Invalid atomic source            | Safe terminal `rejected`; no partial publication; previously published partitions remain unchanged                                                          |
| Dish catalog                     | Complete snapshot reaches `applied`; query is bounded by `snapshot_date`                                                                                    |
| Supplier catalog                 | Complete snapshot reaches `applied`; query uses the current successfully applied source; cleanup restores the prior state                                   |
| Delivery XLSX and CSV            | Two distinct original receipt files reach `applied`; safe owner status confirms ingestion; employee aggregate reads are rejected                            |
| Ledger detail boundary           | Detail, aggregate, raw coverage and original receipt reads are unavailable even for admins, independently of the PDF switch                                 |
| New receipt PDF coverage         | Ingestion success is separate from PDF readiness; coverage shows pending until the configured daily reconciliation runs                                     |
| Existing ready PDF               | Separate ordinary chat prepares/downloads a ZIP for an already-ready authorized store/day; terminal status and source link are valid                        |
| Quarantine workflow              | Explicit receipt/enterprise/store upload using the configured category level, query, 24-hour source link, admin receipt archive, then no active certificate |
| Cleanup                          | All run-owned DB rows, imports, partitions, archive requests, OSS objects and Qdrant points removed; reused account/login and unrelated data preserved      |

`business` and `dishes` use partition extraction, not `query_structured_dataset`. The agent downloads
through the official launcher, analyzes returned CSVs locally, and removes the returned scratch
directory. Employee row-query datasets are VIP, dish catalog and supplier catalog. Raw ledger rows, aggregates, coverage and original signing are unavailable; verify their denial and the separate PDF delivery path. Do not require an employee-produced statutory row table or CSV.

Employees and admins cannot generate PDFs through MCP/HTTP. Use the configured Shanghai schedule
(observe its actual runtime value; 03:00 is the default, not a fixed acceptance assumption). Test
new-receipt pending behavior and a ready historical PDF separately. Do not invoke operator refresh,
change the schedule, or pretend ZIP preparation generates missing PDFs to force a green test.
If a new synthetic PDF's eventual generation is in scope, wait for that schedule and record it as
pending until it runs. Downloads of existing ready PDFs must not mutate their source partitions.

## Upload completion

A queued/202 response is acceptance for processing, not success. Keep the returned IDs and poll
status after 2 seconds, then 5, then 10, then every 15 seconds for up to 10 minutes. Terminal success
is `active/ready` for evidence, `applied` for row imports, and `published` for business/dishes.
Quarantine upload is synchronous. For business/dishes sources over 50 MiB, use the skill's 2-minute
cadence and 20-minute bound. Do not re-upload instead of polling.

Record terminal safe validation errors. `still processing` is not success or failure. Explicit
above-clearance uploads in the account-lifecycle profile cannot be polled/read by the low-clearance
uploader; verify them through the separately logged-in authorized reader and controller evidence.

## Account-lifecycle extension

Skip this entire extension when the human requests the existing-session business profile.
Otherwise create three fresh synthetic identities in the same staging QA organization:

| Email                                             | Role     | Clearance |
| ------------------------------------------------- | -------- | --------: |
| `manual-full-flow-low-<runId>@example.invalid`    | employee |         0 |
| `manual-full-flow-high-<runId>@example.invalid`   | employee |         3 |
| `manual-acceptance-admin-<runId>@example.invalid` | admin    |         0 |

Use `auth:operator onboard` in release-ops with explicit `--role` and `--clearance`. Send one-time
setup links privately to the human. The controller never opens setup links or types passwords.
The human chooses and enters a throwaway password and may disclose it in the current private chat.
Finish setup one account at a time because pages share a host-only cookie. Verify `passwordSet`
operator-side after each confirmation. Never persist setup links, passwords, tokens or headers.

Separate natural login/current-user chats verify each identity. Employee c0/c3 upload requests must
explain admin is required before local file access. Admin c0 uploads explicitly level-0 and level-2 evidence with declared category/scopes. Photo classification follows the configured fixed category level. Give synthetic readers the exact business grants needed for the case: employee c3 can then read level-2 material;
employee c0 and admin c0 cannot. The admin's receipt archive PAO succeeds above clearance and
returns an operational count without first reading the certificate.

Logout/reset/re-login checks use only these synthetic accounts and human-controlled browser input.
`auth:operator reset-password` must revoke old sessions. Delete each synthetic account with
`delete-test-account --email <email> --confirm-email <email>` only after complete data cleanup.
Do not disable, reset, delete or log out the human's reused account.

## Controller runner and cleanup

For a few read-only checks with an already authenticated, explicitly selected admin:

```sh
npm run test:official-manual -- --run-id=<safe-id> --reuse-session=<expected-email> \
  --checks=identity,catalog,ledger-denial
```

`--checks` accepts any nonempty subset of these three names. It uses the pinned launcher and
checks the current account; business checks refresh the permission card. This mode performs no
uploads, controller/SSH cleanup, account operations or structured-window allocation. It rejects
cleanup IDs, `--keep-data` and Evidence configuration to avoid mixing read-only and mutating runs.
The report lists only selected results and marks full acceptance as not run.

The runner is an additional smoke and cleanup helper, not a replacement for natural Codex chats:

```sh
npm run test:official-manual -- --run-id=<safe-id> --evidence-config=/absolute/path/fixture-scope.json
# Explicitly selected current admin; never logs out or changes account attributes:
npm run test:official-manual -- --run-id=<safe-id> --reuse-session=<expected-email> \
  --evidence-config=/absolute/path/fixture-scope.json
# Exact IDs from separate natural chats (repeat each option as needed):
npm run test:official-manual -- cleanup --run-id=<safe-id> \
  --reuse-session=<expected-email> --document-id=<doc-id> \
  --partition-job-id=<job-id> --ledger-request-id=<zip-request-id>
```

Without `--reuse-session`, the runner retains the synthetic admin-c0 guard. The reuse option
checks the live MCP profile and an operator-side active-admin/organization lookup. It does not
add that account to uploader-wide cleanup. Explicit IDs are accepted only in reuse mode and must
belong to that selected account; explicit PDF IDs must be download requests. Run markers handle
runner-owned data, and exact returned IDs handle natural-chat uploads. A report claiming cleanup
success requires post-deletion counts and object/point checks to be zero.

The runner uses the installed official launcher via the MCP SDK. It never reads employee secrets.
Controller-only window allocation, verification and cleanup run over strict-host-key SSH inside the
release-ops image using its root-protected staging configuration. Local `.env` values are not a
substitute for the verified staging RDS target. Cleanup refuses shared ledger partitions and active
processing jobs before deleting their objects. It must also remove partition temporary objects,
garbage entries, quarantines, derived test PDF objects/requests, imports and window claims.

`--keep-data` is for explicitly requested temporary retention, not the normal run. Clean before and
after runner use. Keep natural chats visible; data cleanup does not authorize archiving chats.
Store detailed evidence locally and record only a concise durable milestone in `progress.md`.
Never commit raw chat transcripts, execution ledgers, credentials or test exports.

## Result and exclusions

Report each business case as passed, failed, pending, or excluded with a concrete reason. The
existing-session result must explicitly exclude onboarding/login/logout/reset, identity switching,
employee-upload denial, and cross-clearance authorization proofs. Cite actual created chats and the
local report. Do not report unrestricted beta readiness from that profile.

Stop for credential exposure, direct employee-client infrastructure access, public readiness
exposure, authorization leakage, unrelated-data mutation, or failed cleanup. A controller test
assertion or a prepared plan without real launcher/MCP calls is not acceptance evidence.

Headless support-class-C acceptance separately proves no-display link delivery, human completion
on another device, memory-only credentials, successful business use, and loss of authentication
after process restart. It uses a fresh synthetic account and cleans it afterward.

## Cost-card changed workflow after launcher publication

This section targets the current core-approved, published and independently verified launcher,
separately from the general full-suite runner. This documentation does not authorize execution, user
installation or real tenant changes. After matching service rollout, explicit
synthetic category configuration and a separately requested changed-workflow acceptance, use
`candidateCostCards` in `fixtures/manual-acceptance/scenarios.json`. It is deliberately outside
current `tasks[]`. The fixture `structured/cost-cards-known-values.csv` contains three same-name
cards (same SPU/two specs and same SKU/different SPU), six item rows, standard/exception source text,
exact 36.123456 price, 0.000001/0 quantity and leading-zero SPU/SKU/item codes; no customer data.

Controller sequence and oracles:

1. Track synthetic original/import/card IDs and exact identity; upload the 35-column original
   unchanged. Directory lookup returns all three authorized cards without merging by name/SKU.
2. Download by resolved card IDs, retain each revision/sourceDocumentId/importBatchId in the safe
   manifest, read each 38-column CSV locally with `readCostCardAcceptanceCsv`, check exact field
   values/source locations and both recipe types. Names/specifications must not collide on disk.
   Server queries stay directory-only; source IDs confer no original-read permission.
3. In a separate controller operation, archive only the synthetic original via the approved
   operator boundary. There is no new original-archive employee MCP tool. Re-read directory/CSV:
   active cards remain readable. Do not change category grants to force the result.
4. Archive the resolved small-spec card as current same-org admin; lookup hides it and explicit-ID
   download fails as a whole. A new identical original upload with a fresh key restores it;
   replaying the earlier successful idempotency request does not. Keep the other cards unchanged.
5. Verify summary counts belong to that publication and current access, and keep download/failure
   temporary cleanup in finally. Unit/exception assumptions stay unresolved unless explicit source
   evidence establishes them; no unique final recipe or profit report is expected.
6. Cleanup only run-owned source/card/candidate keys and permission resources before source
   batches/documents. Drain active runs; preserve unrelated cards and all category/grant config.
   An original count of zero alone is insufficient: verify card/resource/garbage/key absence.

Use small focused automated tests for malformed/hidden candidate pages, signing races, one
whole-batch expiry retry, current permissions and exact decimal behavior. Updating fixtures or
support does not resolve the separate evidence-category prerequisite for the full official runner,
prove live service readiness, or authorize the full suite. Historical acceptance reports remain
historical; record final readiness once after all coordinated gates.

接口核对：manifest 为 flat CostCardSelection（非 selection 包裹）；显式缺失／越权 ID
整次 403、数量超限 409 不截断、签名期间变化为 retryable 409“成本卡已变化，请重新下载”，
条件零卡是空 manifest。归档端点无业务 body，响应保留 string revision；员工仍走已验证的
launcher 工具，不为缺少 MCP 接线改用 HTTP。coverage 只统计当前受权未归档目录，按逐卡
sourceDocumentId/importBatchId 分组保留来源计数，原件归档不影响这份目录统计。新增类别
通过“补齐资料类别 / Add missing categories”按钮受控补齐，先处理草稿，以当前版本
和 same Origin／CSRF 写入；验证新 cost_cards 为 null 密级、无 grants、原配置／模式不变。
该步骤限已明确授权的合成租户，不能据此更改真实企业。

发布工具核对：成本卡上传使用原始绝对本地文件＋enterpriseName／idempotencyKey，不传日期、
快照或 confidentialityLevel；用 get_import_status({importBatchId}) 轮询外层
{document,processing,importBatch}。download_cost_cards 返回 localDirectory、dataset=cost_cards、
cardCount、totalItemRowCount、files（仅 cost_card_<costCardId>.csv basename）。目录内 manifest.json
每条保留全部 domain 字段（去 presignedDownloadUrl，增加 fileName），逐卡 string revision／
sourceDocumentId／importBatchId 不丢失。零卡仍有空 files 和有效 manifest。归档调用
archive_cost_card({costCardId})，核对 archived=true 和 string revision。失败／拒绝批次的当前
读者可得源定位与 ignored/source-summary 数组；owner-only 只得安全进度／errorCode，撤权返回404。
原始 storage key、正文链接与原件读取权均不能由状态／来源 ID 泄漏。launcher 发布与独立包验证
不代表服务上线或正式人工验收已完成。
