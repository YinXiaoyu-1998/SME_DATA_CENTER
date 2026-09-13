# Official macOS Codex Manual Acceptance

Last updated: 2026-09-14

This is the active manual acceptance flow for a real beta-style Enterprise Hub user on macOS
Codex. The old local Phase 3 email-login/HTTP-launcher manual acceptance document has been deleted
because it was no longer runnable after the official-auth cutover.

For onboarding an actual beta user, use
[`beta-user-onboarding-runbook.md`](./beta-user-onboarding-runbook.md). This document is the
acceptance-test procedure; the runbook is the support/operator path for a real pilot.

For now, this flow intentionally ignores Windows and OpenClaw. Those remain separate desktop
acceptance gates.

## What This Flow Proves

The acceptance run must exercise both sides of the real product boundary:

| Area                                | Who performs it                   | Required proof                                                                                                                                            |
| ----------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator onboarding                 | Release/operator controller       | `auth:operator onboard` creates an Employee, LoginIdentity, explicit role/clearance, and setup link.                                                      |
| Password setup/reset                | Controller-controlled browser     | Agent-generated test password is entered only into Enterprise Hub HTTPS pages, never reports.                                                             |
| Client installation                 | Employee-owned agent via skill    | Pinned `enterprise-hub-mcp-launcher@0.3.0` is installed and configured as a Codex stdio MCP.                                                              |
| Durable login                       | Launcher + system browser         | `enterprise_hub_login` completes Device Authorization and stores durable credential safely.                                                               |
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

- Never ask the employee to paste a password, setup token, access token, durable credential,
  authorization code, Keychain record, or raw header into chat, files, env vars, or MCP config.
- Password setup and login are completed only in the first-party browser page at
  `https://api.smedatacenter.xyz`.
- For full manual acceptance, do not use the human owner's real account or existing Keychain
  session. The controller creates a fresh synthetic account, generates a temporary test password,
  controls Chrome to set and use it, then deletes the account and all test data. The password is a
  throwaway test secret and must not be written to reports, PRs, docs, env files, or logs.
- Operator setup links contain a one-time secret in the URL fragment. Open them directly in the
  browser or deliver them through a trusted private channel; do not paste full links into reports,
  PR descriptions, or logs.
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
  `~/Library/Application Support/Enterprise Hub/launcher/versions/0.3.0/`;
- Codex configured with the exact `enterprise-hub` stdio MCP entry from
  `skills/enterprise-hub-mcp/SKILL.md`;
- SSH access to the staging host through the committed strict `known_hosts` identity.

The local ignored `.env` remains a local-development configuration and does not need to point to
staging RDS. The runner resolves the live API container over SSH and executes controller-only
window allocation and cleanup inside that container, using its root-protected staging runtime
environment. Alibaba Cloud CLI remains the preferred interface for RDS instance, network, account,
performance, and log diagnostics; application-row verification and cleanup use the staging runtime
because the RDS control-plane API is not an arbitrary SQL execution interface.

Credential-free preflight:

```sh
ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.3.0/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
```

Expected:

- `secureStore.available=true`;
- `server.reachable=true`;
- `server.metadataCompatible=true`;
- `mcp.handshake` is `ok` when already logged in, otherwise `not_authenticated`.

## Operator Account Lifecycle Check

Use three fresh synthetic accounts in `default-org`, never a real customer address. The account
attributes are deliberately orthogonal: role enables only named admin operations, while clearance
governs ordinary reads. Every `onboard` command must state both `--role` and `--clearance`; there is
no product default for either field.

The examples below use one run ID. Each command prints one setup link; keep the link out of logs and
reports and complete its password setup only in Chrome.

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id default-org \
  --email manual-full-flow-low-<run-id>@example.invalid \
  --display-name "Manual Low Clearance <run-id>" \
  --role employee \
  --clearance 0
```

Create the high-clearance ordinary-reader account:

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
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
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id default-org \
  --email manual-acceptance-admin-<run-id>@example.invalid \
  --display-name "Manual Admin Clearance Zero <run-id>" \
  --role admin \
  --clearance 0
```

The command prints exactly one password setup link. Do not store that full link in git or reports.

### Batch Password Setup

Create every synthetic account required for the run before opening any password page. For the
standard confidentiality run this means three accounts; if an added acceptance slice needs more,
create all of those accounts first as well. Generate a distinct throwaway password for each account,
open every setup link in its own Chrome tab, and fill both password fields in every tab before asking
the human to intervene.

Then tell the human the exact number of ready tabs and make one consolidated handoff: they click
**Set password** once in each tab. Do not pause separately after each account. After the human
confirms completion, verify that every tab shows `Password saved` before starting any launcher login.
The controller enters generated passwords only into the first-party browser pages; the human never
needs to type or disclose them.

Password reset uses the same browser-only setup flow:

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js reset-password --employee-id <employee-id>
```

Successful password reset must revoke old launcher sessions. A later product slice should add an
operator disable/reactivate command for real users. All three synthetic full-flow test accounts are
hard-deleted after cleanup. For each account, run:

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
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

| Account                 | One ordinary user-visible request                    | Required proof                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee`, clearance 0 | “帮我把这份肉夹馍 SOP 上传到 Enterprise Hub。”       | The upload omits `confidentialityLevel`, therefore creates level 0. The uploader can poll its status and later search it.                                                                                              |
| `employee`, clearance 0 | “请把这份验收资料按 2 级密级上传到 Enterprise Hub。” | The level is sent only because the employee explicitly said `2`; an upload above the caller's clearance is accepted. The caller's later ordinary status/search request receives no result and must not leak metadata.  |
| `employee`, clearance 3 | “前台折扣说明里有没有通用折扣口令？”                 | A same-organization employee with adequate clearance can find the level-2 fixture through an ordinary MCP read. This is not an admin feature.                                                                          |
| `admin`, clearance 0    | “前台折扣说明里有没有通用折扣口令？”                 | The ordinary search returns no high-level material. `admin` is not a general read bypass.                                                                                                                              |
| `admin`, clearance 0    | “请把收货单 SH2608250117 关联的检疫证明全部归档。”   | `archive_quarantine_certificates` accepts `receiptId` as the named admin-only PAO even when the certificate is level 2 or 3; it returns only `archivedCount`, not document contents, metadata, or a normal read grant. |

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
2. Start from a logged-out launcher state. If another account is present, call `enterprise_hub_logout`
   before starting the full-flow test.
3. Create a new user-visible Codex task/session with an ordinary install/login request, for example
   “帮我安装并登录 Enterprise Hub，我要用它查公司的资料。” The task should follow
   `skills/enterprise-hub-mcp/SKILL.md`. If unauthenticated, it calls `enterprise_hub_login`; the
   controller completes browser login for the synthetic account in Chrome. Do not ask the human to
   type credentials.
4. Create separate user-visible Codex tasks/sessions for each ordinary employee action. Keep each
   visible prompt as one natural request, not a list of test instructions or expected answers. A
   representative sequence is:
   - current account from a fresh task: “我当前登录的 Enterprise Hub 账号是什么身份和保密等级？”
   - default-level evidence upload: “帮我把这份肉夹馍 SOP 放进 Enterprise Hub，之后大家能查到。”
     Do not mention a level; the required result is the service default of 0.
   - explicit-level evidence upload: “请把这份验收资料按 2 级密级上传到 Enterprise Hub。” This
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
     one fresh task with an ordinary request such as “请查询 Enterprise Hub 里的全部收货台账，并按
     台账字段逐行显示成一个表格。” Do not ask only for receipt counts or an enrichment summary.
   - for the quarantine slice, the low-clearance employee first uses
     `fixtures/manual-acceptance/quarantine/animal-quarantine-certificate.jpg` with “帮我把这张检疫
     证明按 2 级密级关联到收货单据 SH2608250117。” The high-clearance employee may then query the
     explicit receipt ID and request a source-file download link. The low-clearance admin must use
     only the receipt-ID archive request above; it must not query all certificates or fetch/proxy
     file bytes.
   - logout/reset/re-login when the run includes recovery: “帮我退出 Enterprise Hub。” then after
     reset/setup, “我又要用 Enterprise Hub 查资料，帮我重新登录。”
5. Do not tell employee-client tasks hidden oracle values such as idempotency keys, expected document
   IDs, expected row counts, query JSON, or permission rules. The sole exception is a requested
   confidentiality level: to test an explicit level, the ordinary user request must say that level
   plainly. A filename or context that appears sensitive is never an implicit level declaration.
6. Start a new launcher process and call `enterprise_hub_auth_status`; it must report
   `authenticated=true`.
7. Call `enterprise_hub_get_current_user` with no arguments and confirm its display name, email,
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
    `get_import_status` to terminal `applied` before querying it.
13. Query the structured rows: expected count `3`, gross sales sum `91`, top two dishes
    `合成凉皮`, `合成肉夹馍`.
14. Upload `fixtures/manual-acceptance/structured/dishes-invalid-atomic.csv`; it must fail
    worker validation, reach a `rejected` terminal state, and not change the successful row count.
15. When the local-only delivery fixtures are available, verify the supplier catalog applies 134
    rows, the XLSX receipt applies 13 ledger rows, and its CSV peer applies 1 row. In a fresh
    employee-client task, query `delivery_ledger` without a receipt filter, follow every opaque page
    cursor until no page remains, and render all visible rows as one Markdown table with these
    columns: 序号、门店名、单据号、进货日期、供货单位名称、食品名称、规格、进货数量、进货金额、
    生产日期或生产批号、保质期、供货单位地址、供货单位联系方式. The acceptance account should
    see exactly the 14 uploaded item rows (13 + 1); verify supplier contacts are enriched per row,
    blank source addresses remain blank, and production/batch plus shelf-life fields remain empty.
    A receipt-level count or field-enrichment summary does not pass this step.
16. For the quarantine slice, upload exactly one level-2 certificate to `SH2608250117` from the
    clearance-0 employee, but only because the visible request expressly says level 2. The
    clearance-3 employee queries `query_quarantine_certificates` with that explicit receipt ID,
    verifies the returned `sourceDocumentId`, calls `get_source_document_download_url`, and confirms
    a 24-hour attachment link without fetching file bytes. Then log in as the clearance-0 admin and
    archive by `receiptId`; verify the PAO returns `archivedCount` and the high-clearance employee's
    repeat explicit query has no active certificate. Do not use an ordinary admin read as evidence
    for this PAO.
17. Call `enterprise_hub_logout` at the end of the full-flow test. It signs out all local agents
    sharing the Enterprise Hub credential for this OS user.
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
- runs against the published `enterprise-hub-mcp-launcher@0.3.0` and requires the low-clearance
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
- `enterprise_hub_login` returns the first-party device verification link (with prefilled
  `user_code`) instead of opening a browser;
- the employee opens the link on a phone or any other device, confirms the agent instance name,
  and completes email/password login on the verification page;
- the launcher's background polling completes and an authenticated business MCP tool call succeeds
  (for example `enterprise_hub_get_current_user`);
- after the launcher process is restarted, `enterprise_hub_auth_status` reports unauthenticated and
  a fresh tap-link login is required (memory-only session);
- cleanup removes the synthetic account and all run-scoped data from DB/storage/Qdrant.

## Pass / Fail

Pass only when:

- self-check is healthy;
- three fresh synthetic test accounts were created with their explicit role/clearance, password
  setup/login was completed through Chrome, and every account was deleted afterward;
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

- any request to paste passwords/tokens into chat/config/env;
- direct employee-client HTTP/DB/Qdrant/storage use instead of MCP;
- public `/readyz` exposure;
- cross-organization or above-clearance data leakage;
- fixture data left in staging after cleanup;
- fabricated success without actual launcher/MCP tool calls.
