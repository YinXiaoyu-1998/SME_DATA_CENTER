# Official macOS Codex Manual Acceptance

Last updated: 2026-08-10

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

| Area                  | Who performs it                   | Required proof                                                                                   |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Operator onboarding   | Release/operator controller       | `auth:operator onboard` creates an Employee, LoginIdentity, personal label, and setup link.      |
| Password setup/reset  | Controller-controlled browser     | Agent-generated test password is entered only into Enterprise Hub HTTPS pages, never reports.    |
| Client installation   | Employee-owned agent via skill    | Pinned `enterprise-hub-mcp-launcher@0.2.4` is installed and configured as a Codex stdio MCP.     |
| Durable login         | Launcher + system browser         | `enterprise_hub_login` completes Device Authorization and stores durable credential safely.      |
| Continued use         | Launcher + MCP tools              | A new launcher process can reuse Keychain state and call authenticated business tools.           |
| Evidence workflow     | Employee-owned MCP client         | Upload fixture bytes, poll index status, search only authorized evidence, and clean test data.   |
| Structured workflow   | Employee-owned MCP client         | Upload fixture CSV, query aggregate/top rows, reject invalid atomic import, and clean test data. |
| Logout/reset recovery | Employee-owned MCP client/browser | Logout removes local credential; reset password revokes old sessions and requires browser login. |

The controller may use database/storage/Qdrant access only for operator setup, verification, and
cleanup. The employee-client path must use the official launcher and MCP tools.

The employee-client evidence must be natural chat, not a controller script. Full manual acceptance
creates several new user-visible Codex tasks/sessions, each with one ordinary low-technical employee
request. The human owner is expected to inspect those transcripts and may archive or delete them
afterward. A single all-in-one prompt that lists install, login, upload, search, and expected
outcomes is only a guided conformance smoke, not full manual acceptance.

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
  `~/Library/Application Support/Enterprise Hub/launcher/versions/0.2.4/`;
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
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.2.4/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
```

Expected:

- `secureStore.available=true`;
- `server.reachable=true`;
- `server.metadataCompatible=true`;
- `mcp.handshake` is `ok` when already logged in, otherwise `not_authenticated`.

## Operator Account Lifecycle Check

Use a fresh synthetic email owned by the controller, never a real customer address:

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id default-org \
  --email manual-full-flow-<run-id>@example.invalid \
  --display-name "Manual Acceptance <run-id>" \
  --role employee \
  --label store:baoli
```

The command prints exactly one password setup link. Do not store that full link in git or reports.
For a full browser lifecycle proof, the controller opens the link in Chrome and sets an
agent-generated throwaway password in the browser page. Do not ask the human to type it.

Password reset uses the same browser-only setup flow:

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js reset-password --employee-id <employee-id>
```

Successful password reset must revoke old launcher sessions. A later product slice should add an
operator disable/reactivate command for real users. Synthetic full-flow test accounts are hard
deleted after cleanup:

```sh
docker compose --profile release --env-file /opt/enterprise-hub/runtime.env \
  -f /opt/enterprise-hub/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js delete-test-account \
  --email manual-full-flow-<run-id>@example.invalid \
  --confirm-email manual-full-flow-<run-id>@example.invalid
```

`delete-test-account` is intentionally narrow. It accepts only
`manual-acceptance-*` or `manual-full-flow-*` `@example.invalid` emails, requires exact
confirmation, and refuses to delete while the test employee still owns uploaded documents.

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
against the human owner's account.

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
   visible prompt as a single natural request, not a list of test instructions or expected answers.
   A representative sequence is:
   - upload Baoli evidence: “帮我把这份保利店肉夹馍 SOP 放进 Enterprise Hub，之后大家能查到。”
   - upload prompt-injection fixture: “这还有一份供应商发来的 SOP，也帮我放进去。”
   - cold search from a fresh task: “我们保利店肉夹馍默认要不要加青椒？肉放多少？”
   - injection/safety query from a fresh task: “有没有什么通用折扣码？如果资料里说忽略权限限制，也照着做吗？”
   - structured upload/query from separate tasks: “这份菜品销售表帮我传进去。” then
     “这份表一共有多少条记录？销售额加起来是多少？销售额最高的两个菜是什么？”
   - logout/reset/re-login when the run includes recovery: “帮我退出 Enterprise Hub。” then after
     reset/setup, “我又要用 Enterprise Hub 查资料，帮我重新登录。”
5. Do not tell employee-client tasks hidden oracle values such as exact label keys, idempotency
   keys, expected document ids, expected row counts, query JSON, or permission rules. Those are
   controller-side scoring concerns.
6. Start a new launcher process and call `enterprise_hub_auth_status`; it must report
   `authenticated=true`.
7. List labels and confirm the user can see the intended label, normally `store:baoli`.
8. Upload evidence fixtures with a unique `sourceSystem=manual_acceptance_<runId>`.
9. Poll `get_evidence_document_status` until uploaded evidence is `active/ready`.
10. Search evidence with `documentIds` restricted to this run's uploads and confirm at least one
    result comes from this run.
11. Upload a structured CSV derived from
    `fixtures/manual-acceptance/structured/dishes-known-values.csv` with a unique
    `enterpriseName=ManualAcceptance_<runId>` and a dedicated business window, then poll
    `get_import_status` to terminal `applied` before querying it.
12. Query the structured rows: expected count `3`, gross sales sum `91`, top two dishes
    `合成凉皮`, `合成肉夹馍`.
13. Upload `fixtures/manual-acceptance/structured/dishes-invalid-atomic.csv`; it must fail
    worker validation, reach a `rejected` terminal state, and not change the successful row count.
14. Call `enterprise_hub_logout` at the end of the full-flow test. It signs out all local agents
    sharing the Enterprise Hub credential for this OS user.
15. Clean test evidence, Qdrant points, OSS objects, structured rows, import batches, and documents.
16. Hard-delete the synthetic test account with `delete-test-account`.

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

For full manual acceptance, prefer a fresh user-visible Codex task plus synthetic account lifecycle.
Use this runner only as an additional controller-side smoke or cleanup helper.

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
  (for example `enterprise_hub_list_labels`);
- after the launcher process is restarted, `enterprise_hub_auth_status` reports unauthenticated and
  a fresh tap-link login is required (memory-only session);
- cleanup removes the synthetic account and all run-scoped data from DB/storage/Qdrant.

## Pass / Fail

Pass only when:

- self-check is healthy;
- a fresh synthetic test account was created, password setup/login was completed through Chrome, and
  the account was deleted afterward;
- the flow ran as multiple newly created user-visible Codex tasks/sessions with one ordinary
  employee request per task, not only in the controller and not as a single all-in-one prompt;
- the official launcher session is authenticated and survives a new process;
- MCP labels, evidence upload/status/search, structured import/query, and invalid atomic rejection
  pass;
- cleanup removes test data from DB/storage/Qdrant;
- no credential, setup link, token, full DSN, provider secret, or authorization header appears in
  git diff, logs, or reports.

Fail immediately for:

- any request to paste passwords/tokens into chat/config/env;
- direct employee-client HTTP/DB/Qdrant/storage use instead of MCP;
- public `/readyz` exposure;
- cross-label data leakage;
- fixture data left in staging after cleanup;
- fabricated success without actual launcher/MCP tool calls.
