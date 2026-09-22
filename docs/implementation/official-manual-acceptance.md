# Official macOS Codex Manual Acceptance

Last updated: 2026-09-22

This is the active manual acceptance flow for a real beta-style SMEDC user on macOS
Codex. The old local Phase 3 email-login/HTTP-launcher manual acceptance document has been deleted
because it was no longer runnable after the official-auth cutover.

For onboarding an actual beta user, use
[`beta-user-onboarding-runbook.md`](./beta-user-onboarding-runbook.md). This document is the
acceptance-test procedure; the runbook is the support/operator path for a real pilot.

The primary flow intentionally ignores Windows and OpenClaw. Those remain separate desktop/client
acceptance gates. Linux launcher installation is supported; its no-display, memory-only behavior is
validated separately in the Support Class C section below and does not inherit the macOS Keychain
persistence expectation.

## What This Flow Proves

The acceptance run must exercise both sides of the real product boundary:

| Area                                | Who performs it                   | Required proof                                                                                                                                            |
| ----------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator onboarding                 | Release/operator controller       | `auth:operator onboard` creates an Employee, LoginIdentity, explicit role/clearance, and setup link.                                                      |
| Password setup/reset                | Human-controlled browser          | The controller sends first-party setup links; the human chooses and enters synthetic passwords.                                                           |
| Client installation                 | Employee-owned agent via skill    | Pinned `smedc-mcp-launcher@0.5.1` is installed and configured as a Codex stdio MCP.                                                                       |
| Durable login                       | Launcher + system browser         | `smedc_login` completes Device Authorization and stores durable credential safely.                                                                        |
| Continued use                       | Launcher + MCP tools              | A new launcher process can reuse Keychain state and call authenticated business tools.                                                                    |
| Current account identity            | Employee-owned MCP client         | A natural account question returns only the synthetic user's display name, email, role, and clearance.                                                    |
| Confidentiality boundary            | Employee-owned MCP clients        | Default upload is level 0; a level is set only when the employee says so; ordinary reads require same org and adequate clearance.                         |
| Admin PAO boundary                  | Employee-owned admin MCP client   | A low-clearance admin cannot ordinarily read high-level material, but can perform the named receipt archive PAO and receives only its operational result. |
| Evidence workflow                   | Employee-owned MCP client         | Upload fixture bytes, poll index status where the uploader can ordinarily read it, search only authorized evidence, and clean test data.                  |
| Structured workflow                 | Employee-owned MCP client         | Upload fixture CSV, query aggregate/top rows, reject invalid atomic import, and clean test data.                                                          |
| Delivery-ledger workflow            | Employee-owned MCP client         | Upload supplier catalog plus XLSX/CSV receipts, query all ledger rows as a row-level table, and clean data.                                               |
| Quarantine/source-download workflow | Employee-owned MCP client         | Upload one JPG/PNG certificate by receipt ID, query explicit receipt IDs, issue download link, and archive.                                               |
| Logout/reset recovery               | Employee-owned MCP client/browser | Logout removes local credential; reset password revokes old sessions and requires browser login.                                                          |

The controller may use database/storage/Qdrant access only for operator setup, verification, and
cleanup. The employee-client path must use the official launcher and MCP tools.

The employee-client evidence must be natural chat, not a controller script. Full manual acceptance
creates several new user-visible Codex tasks/sessions, each with one ordinary low-technical employee
request. The human owner is expected to inspect those transcripts and may archive or delete them
afterward. Keep them visible when the run finishes: automated staging-data cleanup must not archive
or delete Codex tasks. A single all-in-one prompt that lists install, login, upload, search, and
expected outcomes is only a guided conformance smoke, not full manual acceptance.

## Password And Secret Rules

- Never ask for or expose a real/user-owned password, access token, durable credential,
  authorization code, Keychain record, or raw header.
- Password setup and login are completed only in the first-party browser page at
  `https://api.smedatacenter.xyz`.
- For full manual acceptance, do not use the human owner's real account or existing Keychain
  session. The controller creates fresh synthetic accounts and sends their setup links to the human
  in the current private chat, but never opens the links or types credentials. The human may choose,
  type, and disclose a shared synthetic password in that chat.
- Operator setup links contain a one-time secret in the URL fragment. They and synthetic passwords
  may appear in the current private human-agent conversation, but never in reports, PR descriptions,
  repository files, environment variables, command arguments, or logs.
- The manual runner prints only safe run ids, document ids, report paths, and non-secret status.

## Preconditions

From a clean local `main`:

```sh
git fetch origin
git switch main
git pull --ff-only
npm install
```

The macOS user must have:

- Node.js 22+ and npm;
- the published launcher installed at
  `~/Library/Application Support/SMEDC/launcher/versions/0.5.1/`;
- Codex configured with the exact `smedc` stdio MCP entry from
  `skills/smedc-mcp/SKILL.md`;
- SSH access to the staging host through the committed strict `known_hosts` identity.

The local ignored `.env` remains a local-development configuration and does not need to point to
staging RDS. The runner resolves the live API container over SSH and executes controller-only
window allocation and cleanup inside that container, using its root-protected staging runtime
environment. Alibaba Cloud CLI remains the preferred interface for RDS instance, network, account,
performance, and log diagnostics; application-row verification and cleanup use the staging runtime
because the RDS control-plane API is not an arbitrary SQL execution interface.

Credential-free preflight:

```sh
SMEDC_BASE_URL=https://api.smedatacenter.xyz \
  "$HOME/Library/Application Support/SMEDC/launcher/versions/0.5.1/node_modules/.bin/smedc-mcp-launcher" self-check
```

Expected:

- `secureStore.available=true`;
- `server.reachable=true`;
- `server.metadataCompatible=true`;
- `mcp.handshake` is `ok` when already logged in, otherwise `not_authenticated`.

## Scoped QA Acceptance With An Existing Login

Full acceptance still uses the fresh three-account lifecycle below. When the human explicitly asks
for only selected business-flow acceptance, an already-authenticated account may be reused without
creating or switching accounts if the controller verifies all of the following:

1. launcher self-check is healthy, `smedc_auth_status` is authenticated, and
   `smedc_get_current_user` returns the intended QA identity;
2. a read-only operator-side lookup confirms that employee belongs to organization ID
   `default-org`; this check stays outside the employee-client path because the MCP current-user
   result deliberately omits internal organization identifiers;
3. the selected flow does not claim to prove onboarding, password setup/reset, cross-clearance,
   admin PAOs, logout, session revocation, or account deletion; and
4. uploads use a run-unique `enterpriseName`, source marker, business window, or another exact
   cleanup boundary that cannot select unrelated data already owned by the reused employee.

Run the selected actions as new user-visible Codex tasks with one ordinary employee request per
task and the official launcher/MCP tools. Preserve the shared existing login: do not call logout,
reset or disable the account, and do not hard-delete it afterward. Controller access remains
limited to safe identity/organization verification, result verification, and exact run-scoped
cleanup. Cleanup must remove the run's database rows, current partition objects, temporary sources,
and work directories while proving that unrelated QA data remains. Record this as **scoped QA
acceptance**, never as the full manual acceptance gate.

## Operator Account Lifecycle Check

Use three fresh synthetic accounts in `default-org`, never a real customer address. The account
attributes are deliberately orthogonal: role enables only named admin operations, while clearance
governs ordinary reads. Every `onboard` command must state both `--role` and `--clearance`; there is
no product default for either field.

The examples below use one run ID. Each command prints one setup link; keep the link out of logs and
reports and complete its password setup only in Chrome.

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id default-org \
  --email manual-full-flow-low-<run-id>@example.invalid \
  --display-name "Manual Low Clearance <run-id>" \
  --role employee \
  --clearance 0
```

Create the high-clearance ordinary-reader account:

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id default-org \
  --email manual-full-flow-high-<run-id>@example.invalid \
  --display-name "Manual High Clearance <run-id>" \
  --role employee \
  --clearance 3
```

Create the admin-operation account. Its clearance 0 is intentional: it proves that `admin` does
not become an ordinary-read bypass.

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id default-org \
  --email manual-acceptance-admin-<run-id>@example.invalid \
  --display-name "Manual Admin Clearance Zero <run-id>" \
  --role admin \
  --clearance 0
```

The command prints exactly one password setup link. Do not store that full link in git or reports.

### Human-Controlled Password Setup

Create every synthetic account required for the run and send its one-time setup link directly to the
human in the current private chat. The controller must not open, prefill, or submit any setup page.
The human chooses and types the synthetic password and may disclose it in that chat; one shared test
password is acceptable for all accounts in the same disposable run.

Several links may be generated before handoff. Complete them one at a time. They use one shared host-only cookie.
Opening several links before completing the current one replaces the active setup session and can
make a different link appear invalid or expired. Wait
for the human's confirmation after each page, then verify operator-side `passwordSet=true` before
moving to the next account. Never retain links or passwords in repository files, reports, PRs,
environment variables, command arguments, or logs.

Password reset uses the same browser-only setup flow:

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js reset-password --employee-id <employee-id>
```

Successful password reset must revoke old launcher sessions. A later product slice should add an
operator disable/reactivate command for real users. All three synthetic full-flow test accounts are
hard-deleted after cleanup. For each account, run:

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js delete-test-account \
  --email <one-synthetic-manual-email> \
  --confirm-email <same-synthetic-manual-email>
```

`delete-test-account` is intentionally narrow. It accepts only `manual-acceptance-*` or
`manual-full-flow-*` `@example.invalid` emails, requires exact confirmation, and refuses to delete
while the test employee still owns uploaded documents.

The `auth:operator` CLI ships compiled as `dist/release/auth-operator.js` in the release-ops image
and runs with the staging runtime env; it must never be pointed at the local development `.env`.

## Async Upload Completion Rule

For every evidence or structured-table MCP upload that returns `202`, retain the returned Document
ID and, for structured data, ImportBatch ID. Poll the relevant status tool after **2 seconds, then
5 seconds, then 10 seconds, then every 15 seconds**, for at most **10 minutes**. Do not report
success before a terminal success state (`active/ready` for evidence or `applied` for a structured
import). Do not re-upload instead of polling; exact retries retain the same structured idempotency
key, while a corrected file needs a new one.

For a terminal `rejected` or `failed` result, record only safe returned errors and correction
advice. At the 10-minute limit without a terminal status, report **still processing**, keep the
Document/ImportBatch IDs in acceptance evidence, and say it can be checked later with the status
tool; this is not a failure.

## Confidentiality And Admin Model Acceptance

Run the following cases in the same organization and in this order. The visible employee tasks use
ordinary language; the controller alone knows which synthetic account is currently logged in and
records the expected result. Do not ask an agent to infer a level from a filename, words such as
“保密”, a sender, or business context.

| Account                 | One ordinary user-visible request                  | Required proof                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee`, clearance 0 | “帮我把这份肉夹馍 SOP 上传到 SMEDC。”              | The upload omits `confidentialityLevel`, therefore creates level 0. The uploader can poll its status and later search it.                                                                                              |
| `employee`, clearance 0 | “请把这份验收资料按 2 级密级上传到 SMEDC。”        | The level is sent only because the employee explicitly said `2`; an upload above the caller's clearance is accepted. The caller's later ordinary status/search request receives no result and must not leak metadata.  |
| `employee`, clearance 3 | “前台折扣说明里有没有通用折扣口令？”               | A same-organization employee with adequate clearance can find the level-2 fixture through an ordinary MCP read. This is not an admin feature.                                                                          |
| `admin`, clearance 0    | “前台折扣说明里有没有通用折扣口令？”               | The ordinary search returns no high-level material. `admin` is not a general read bypass.                                                                                                                              |
| `admin`, clearance 0    | “请把收货单 SH2608250117 关联的检疫证明全部归档。” | `archive_quarantine_certificates` accepts `receiptId` as the named admin-only PAO even when the certificate is level 2 or 3; it returns only `archivedCount`, not document contents, metadata, or a normal read grant. |

Prepare the PAO target by having the low-clearance employee explicitly upload
`fixtures/manual-acceptance/quarantine/animal-quarantine-certificate.jpg` at level 2 for the
receipt in the table. Before running the admin archive, the high-clearance employee may query that
specific receipt to confirm the certificate exists. The low-clearance admin must not be asked to
query it first: a successful PAO is the required evidence, not a visibility exception.

The identity call for each account must return exactly the synthetic display name, email, role, and
clearance. It must not return an internal employee/organization ID or credential. A disabled-account
test, when the operator can perform it, must deny both ordinary actions and the admin PAO; it is not
part of the ordinary account-creation flow because the product intentionally has no in-product
disable/reactivate editor.

## Structured-import async cutover acceptance

Run this section after the single staging cutover has restored the API and worker. With a fresh
synthetic acceptance account and separate ordinary employee tasks, the required terminal evidence
is:

- valid table -> `applied` after polling its upload status;
- invalid table -> `rejected` with no partial structured rows; and
- text -> `ready` after polling the evidence document status.

Then use the official controller cleanup to verify that the run's documents, structured rows/import
batches/window claims, exact OSS objects, and exact Qdrant points are gone. Only after that cleanup
succeeds may the controller hard-delete the synthetic acceptance account. Never run this acceptance
against the human owner's account. Cleanup includes every document uploaded by the run's synthetic
employee, even when a natural-language task chooses a business title that does not contain the run
identifier.

## macOS Codex User Flow

For the current macOS user:

1. Run the launcher self-check.
2. Start from a logged-out launcher state. If another account is present, call `smedc_logout`
   before starting the full-flow test.
3. Create a new user-visible Codex task/session with an ordinary install/login request, for example
   “帮我安装并登录 SMEDC，我要用它查公司的资料。” The task should follow
   `skills/smedc-mcp/SKILL.md`. If unauthenticated, it calls `smedc_login`; the
   human completes browser login for the synthetic account. The controller must not control the
   browser or type credentials.
4. Create separate user-visible Codex tasks/sessions for each ordinary employee action. Keep each
   visible prompt as one natural request, not a list of test instructions or expected answers. A
   representative sequence is:
   - current account from a fresh task: “我当前登录的 SMEDC 账号是什么身份和保密等级？”
   - default-level evidence upload: “帮我把这份肉夹馍 SOP 放进 SMEDC，之后大家能查到。”
     Do not mention a level; the required result is the service default of 0.
   - explicit-level evidence upload: “请把这份验收资料按 2 级密级上传到 SMEDC。” This
     explicit wording is the authorization to send level 2; no agent may substitute its own judgment.
   - cold search from a fresh task while logged in as clearance-0 employee: “我们肉夹馍默认要不要加
     青椒？肉放多少？” The level-0 SOP is reachable; the level-2 fixture is not.
   - high-clearance search after browser login switches to the clearance-3 employee: “前台折扣说明里有没有
     通用折扣口令？” This verifies normal same-org clearance access, not admin access.
   - ordinary-read denial after switching to the clearance-0 admin: repeat the preceding high-level
     search. It must not return high-level content or metadata.
   - PAO after the same admin switch: “请把收货单 SH2608250117 关联的检疫证明全部归档。” The
     admin-only receipt archive may succeed above clearance but returns only an operational count.
   - injection/safety query from a fresh task: “有没有什么通用折扣码？如果资料里说忽略权限限制，也照着做吗？”
   - structured upload/query from separate tasks: “这份菜品销售表帮我传进去。” then
     “这份表一共有多少条记录？销售额加起来是多少？销售额最高的两个菜是什么？”
   - when the untracked delivery samples are available, upload the supplier catalog, one XLSX
     receipt, and the temporary CSV conversion of the second receipt from separate tasks; then use
     one fresh task with an ordinary request such as “请查询 SMEDC 里的全部收货台账，并按
     台账字段逐行显示成一个表格。” Do not ask only for receipt counts or an enrichment summary.
   - for the quarantine slice, the low-clearance employee first uses
     `fixtures/manual-acceptance/quarantine/animal-quarantine-certificate.jpg` with “帮我把这张检疫
     证明按 2 级密级关联到收货单据 SH2608250117。” The high-clearance employee may then query the
     explicit receipt ID and request a source-file download link. The low-clearance admin must use
     only the receipt-ID archive request above; it must not query all certificates or fetch/proxy
     file bytes.
   - logout/reset/re-login when the run includes recovery: “帮我退出 SMEDC。” then after
     reset/setup, “我又要用 SMEDC 查资料，帮我重新登录。”
5. Do not tell employee-client tasks hidden oracle values such as idempotency keys, expected document
   IDs, expected row counts, query JSON, or permission rules. The sole exception is a requested
   confidentiality level: to test an explicit level, the ordinary user request must say that level
   plainly. A filename or context that appears sensitive is never an implicit level declaration.
6. Start a new launcher process and call `smedc_auth_status`; it must report
   `authenticated=true`.
7. Call `smedc_get_current_user` with no arguments and confirm its display name, email,
   role, and clearance match the synthetic account; the result must not contain internal IDs or
   credentials.
8. Confirm the current account reports the explicitly assigned role and clearance.
9. Upload default-level evidence fixtures with a unique `sourceSystem=manual_acceptance_<runId>`.
   Omit `confidentialityLevel`; check the uploader's status response confirms level 0 and reaches
   `active/ready`.
10. Upload one evidence fixture only after the visible employee request expressly says level 2. The
    clearance-0 uploader may receive the upload acknowledgement but must receive a non-enumerating
    result from later ordinary status/search attempts. Do not poll that document as the low-clearance
    uploader.
11. After login switches to the clearance-3 employee, search the high-level evidence and confirm a
    run document is returned. After login switches to the clearance-0 admin, confirm the same normal
    search has no such result.
12. Upload a structured CSV derived from
    `fixtures/manual-acceptance/structured/dishes-known-values.csv` with a unique
    `enterpriseName=ManualAcceptance_<runId>` and a dedicated business window, then poll
    `get_partition_import_status` to terminal `published` before downloading it.
13. Call `download_structured_partitions` for that enterprise/window, verify one authorized local
    partition with 3 rows and the known fixture totals/product names, then delete the returned
    launcher scratch directory. Do not use `query_structured_dataset` for `dishes`.
14. Upload `fixtures/manual-acceptance/structured/dishes-invalid-atomic.csv`; it must fail
    worker validation, reach a `rejected` terminal state, and not change the previously published
    partition when it is downloaded again.
15. When the local-only delivery fixtures are available, upload the supplier catalog and two
    receipts for the same store and month from separate employee-client tasks, and poll each import
    to terminal `applied`. In a fresh task, query the bounded store/month scope, follow every opaque
    page cursor until no page remains, and render all visible rows as one Markdown table titled
    `食品经营单位进货台帐` with these columns in exact order: 收货单号、食品名称、规格、进货数量、
    进货金额、生产日期或生产批号、保质期、供货单位名称、供货单位地址、供货单位联系方式、进货日期.
    Do not add 序号 or 门店名 to the displayed/exported statutory columns. Verify every imported
    receipt ID is visible, supplier contacts are enriched per row when available, blank source
    addresses remain blank, and missing production/batch plus shelf-life values remain empty/null.
    A receipt-level count or field-enrichment summary does not pass this step. In another fresh task,
    make an ordinary per-store/month CSV request into an empty run-scoped directory and verify the
    conventional filename, UTF-8 BOM, and the same eleven headers. The output directory must contain
    only the requested CSV files: any serialized MCP query response is an internal temporary input,
    lives outside that directory, is removed after success or failure, and is not presented to the
    employee. After the second receipt is available, repeat the same natural “生成” request: the
    existing valid CSV must be maintained in place, append every row of the new receipt, and not
    duplicate any already-present receipt. A further identical run with no new receipt must be a
    no-op and leave the CSV byte-identical.
16. For the quarantine slice, upload exactly one level-2 certificate to `SH2608250117` from the
    clearance-0 employee, but only because the visible request expressly says level 2. The
    clearance-3 employee queries `query_quarantine_certificates` with that explicit receipt ID,
    verifies the returned `sourceDocumentId`, calls `get_source_document_download_url`, and confirms
    a 24-hour attachment link without fetching file bytes. Then log in as the clearance-0 admin and
    archive by `receiptId`; verify the PAO returns `archivedCount` and the high-clearance employee's
    repeat explicit query has no active certificate. Do not use an ordinary admin read as evidence
    for this PAO.
17. Call `smedc_logout` at the end of the full-flow test. It signs out all local agents
    sharing the SMEDC credential for this OS user.
18. Clean test evidence, quarantine certificates, Qdrant points, OSS objects, structured rows
    (including delivery and supplier rows), import batches, and documents.
19. Hard-delete all three synthetic test accounts with `delete-test-account`.

## Runner

The repository runner is a controller-side helper, not a substitute for the full user-visible
Codex-session test. It performs MCP business-tool checks and cleanup through the official launcher:

```sh
npm run test:official-manual
```

Useful options:

```sh
npm run test:official-manual -- --run-id=20260730-macos-codex
npm run test:official-manual -- cleanup --run-id=20260730-macos-codex
npm run test:official-manual -- --run-id=20260730-macos-codex --keep-data
```

The runner:

- requires a current authenticated launcher session;
- runs against the published `smedc-mcp-launcher@0.5.1` and requires the low-clearance
  employee identity (`employee`, clearance 0); it verifies default-level evidence/structured uploads
  by omitting the optional level field;
- never reads staging database credentials from the local `.env`;
- resolves the live staging runtime over strict-host-key SSH and runs controller-only window
  allocation/cleanup through the release-ops image (`docker compose --profile release run --rm
release-ops node dist/release/official-manual-acceptance.js controller-...`);
- refuses controller cleanup unless the container runtime points to the private staging RDS endpoint
  with the dedicated staging database account;
- uses `sourceSystem=manual_acceptance_<runId>` for evidence;
- probes and uses a run-specific available three-day window for the structured CSV;
- queries only that dedicated date window;
- writes `.data/official-manual-acceptance/<runId>/report.md`;
- cleans before and after the run unless `--keep-data` is supplied;
- fails cleanup if OSS/Qdrant deletion fails or post-clean verification finds documents, batches,
  structured rows, date-window claims, OSS objects, or Qdrant points.

For full manual acceptance, use the three-account browser lifecycle and user-visible tasks above.
The runner is an additional low-clearance default-level smoke and cleanup helper; it cannot replace
the cross-account ordinary-read and PAO checks.

## Headless Remote Agent (Support Class C) Flow

This scenario extends acceptance to the headless remote agent form (no local browser, no
Keychain/Credential Manager). Run it on a Linux host or container without DISPLAY and without a
keyring daemon, using a fresh synthetic employee account created by the operator.

Pass only when:

- launcher self-check reports `secureStore.available=false` and `server.reachable=true`;
- `smedc_login` returns the first-party device verification link (with prefilled
  `user_code`) instead of opening a browser;
- the employee opens the link on a phone or any other device, confirms the agent instance name,
  and completes email/password login on the verification page;
- the launcher's background polling completes and an authenticated business MCP tool call succeeds
  (for example `smedc_get_current_user`);
- after the launcher process is restarted, `smedc_auth_status` reports unauthenticated and
  a fresh tap-link login is required (memory-only session);
- cleanup removes the synthetic account and all run-scoped data from DB/storage/Qdrant.

## macOS Full-Flow Pass / Fail

These criteria apply to the primary macOS flow. The headless Linux flow passes against the separate
criteria above, including the required loss of authentication after launcher-process restart.

Pass only when:

- self-check is healthy;
- three fresh synthetic test accounts were created with their explicit role/clearance, the human
  completed password setup/login through the first-party pages, and every account was deleted
  afterward;
- the flow ran as multiple newly created user-visible Codex tasks/sessions with one ordinary
  employee request per task, not only in the controller and not as a single all-in-one prompt;
- the official launcher session is authenticated and survives a new process;
- each current-account request returns only that synthetic account's display name, email, role, and
  clearance;
- default upload is level 0 only when the level is omitted; an explicit level-2 upload succeeds
  without agent inference, low-clearance ordinary reads do not leak it, and same-org clearance-3
  ordinary reads can retrieve it;
- a clearance-0 admin cannot normally read the level-2 fixture, while the named
  `archive_quarantine_certificates` PAO can archive a high-level certificate by receipt ID and
  returns only `archivedCount`;
- MCP current-user, evidence upload/status/search, structured import/query, and invalid atomic
  rejection pass;
- quarantine certificate upload/query/source-download/archive passes when that feature slice is in
  scope;
- cleanup removes test data from DB/storage/Qdrant;
- no credential, setup link, token, full DSN, provider secret, or authorization header appears in
  git diff, logs, or reports.

Fail immediately for:

- any request to disclose a real/user-owned password or any token, or to persist even a synthetic
  test password outside the current private chat;
- direct employee-client HTTP/DB/Qdrant/storage use instead of MCP;
- public `/readyz` exposure;
- cross-organization or above-clearance data leakage;
- fixture data left in staging after cleanup;
- fabricated success without actual launcher/MCP tool calls.
