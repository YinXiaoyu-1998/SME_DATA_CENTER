# Official macOS Codex Manual Acceptance

Last updated: 2026-07-30

This is the active manual acceptance flow for a real beta-style Enterprise Hub user on macOS
Codex. It supersedes the withdrawn local Phase 3 email-login suite in
`docs/implementation/local-agent-test.md`.

For now, this flow intentionally ignores Windows and OpenClaw. Those remain separate desktop
acceptance gates.

## What This Flow Proves

The acceptance run must exercise both sides of the real product boundary:

| Area                  | Who performs it                   | Required proof                                                                                   |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Operator onboarding   | Release/operator controller       | `auth:operator onboard` creates an Employee, LoginIdentity, personal label, and setup link.      |
| Password setup/reset  | Employee in browser               | Password is entered only on Enterprise Hub HTTPS pages; the agent never sees it.                 |
| Client installation   | Employee-owned agent via skill    | Pinned `enterprise-hub-mcp-launcher@0.1.0` is installed and configured as a Codex stdio MCP.     |
| Durable login         | Launcher + system browser         | `enterprise_hub_login` completes Authorization Code + PKCE and stores durable credential safely. |
| Continued use         | Launcher + MCP tools              | A new launcher process can reuse Keychain state and call authenticated business tools.           |
| Evidence workflow     | Employee-owned MCP client         | Upload fixture bytes, poll index status, search only authorized evidence, and clean test data.   |
| Structured workflow   | Employee-owned MCP client         | Upload fixture CSV, query aggregate/top rows, reject invalid atomic import, and clean test data. |
| Logout/reset recovery | Employee-owned MCP client/browser | Logout removes local credential; reset password revokes old sessions and requires browser login. |

The controller may use database/storage/Qdrant access only for operator setup, verification, and
cleanup. The employee-client path must use the official launcher and MCP tools.

## Password And Secret Rules

- Never ask the employee to paste a password, setup token, access token, durable credential,
  authorization code, Keychain record, or raw header into chat, files, env vars, or MCP config.
- Password setup and login are completed only in the first-party browser page at
  `https://api.smedatacenter.xyz`.
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
  `~/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/`;
- Codex configured with the exact `enterprise-hub` stdio MCP entry from
  `skills/enterprise-hub-mcp/SKILL.md`;
- a local ignored `.env` containing staging `DATABASE_URL`, `STORAGE_DRIVER=oss`, OSS variables,
  Qdrant variables, and real provider acknowledgement for cleanup and readiness checks.

Credential-free preflight:

```sh
ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
```

Expected:

- `secureStore.available=true`;
- `server.reachable=true`;
- `server.metadataCompatible=true`;
- `mcp.handshake` is `ok` when already logged in, otherwise `not_authenticated`.

## Operator Account Lifecycle Check

Use a synthetic email owned by the operator, not a real customer address:

```sh
npm run auth:operator -- onboard \
  --org-id org_demo \
  --email manual-acceptance-<run-id>@example.invalid \
  --display-name "Manual Acceptance <run-id>" \
  --role employee \
  --label store:baoli
```

The command prints exactly one password setup link. Do not store that full link in git or reports.
For a full browser lifecycle proof, open the link, let the employee set the password in the
browser, then run the official launcher login. If the run is only verifying that operator account
creation still works, stop after confirming the command produced a link and record that browser
password setup was skipped.

Password reset uses the same browser-only setup flow:

```sh
npm run auth:operator -- reset-password --employee-id <employee-id>
```

Successful password reset must revoke old launcher sessions. A later product slice should add an
operator disable/delete command; until then, disable/delete is not part of the executable manual
acceptance flow.

## macOS Codex User Flow

For the current macOS user:

1. Run the launcher self-check.
2. If unauthenticated, use Codex/MCP to call `enterprise_hub_login`; finish email/password entry
   only in the browser.
3. Start a new launcher process and call `enterprise_hub_auth_status`; it must report
   `authenticated=true`.
4. List labels and confirm the user can see the intended label, normally `store:baoli`.
5. Upload evidence fixtures with a unique `sourceSystem=manual_acceptance_<runId>`.
6. Poll `get_evidence_document_status` until uploaded evidence is `active/ready`.
7. Search evidence with `documentIds` restricted to this run's uploads and confirm at least one
   result comes from this run.
8. Upload a structured CSV derived from
   `fixtures/manual-acceptance/structured/dishes-known-values.csv` with a unique
   `enterpriseName=ManualAcceptance_<runId>` and a dedicated business window.
9. Query the structured rows: expected count `3`, gross sales sum `91`, top two dishes
   `合成凉皮`, `合成肉夹馍`.
10. Upload `fixtures/manual-acceptance/structured/dishes-invalid-atomic.csv`; it must fail
    validation and must not change the successful row count.
11. Call `enterprise_hub_logout` only when explicitly testing logout. It signs out all local agents
    sharing the Enterprise Hub credential for this OS user.
12. Clean test evidence, Qdrant points, OSS objects, structured rows, import batches, and documents.

## Runner

The repository runner performs steps 3–10 and cleanup through the official launcher/MCP path:

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
- uses `sourceSystem=manual_acceptance_<runId>` for evidence;
- creates a run-local structured CSV with dates changed to `2030-01-01` through `2030-01-03`;
- queries only that dedicated date window;
- writes `.data/official-manual-acceptance/<runId>/report.md`;
- cleans before and after the run unless `--keep-data` is supplied.

The runner does not create or set account passwords because passwords must remain browser-only.

## Pass / Fail

Pass only when:

- self-check is healthy;
- the official launcher session is authenticated and survives a new process;
- MCP labels, evidence upload/status/search, structured import/query, and invalid atomic rejection
  pass;
- setup/reset account lifecycle is either completed in browser or explicitly recorded as skipped;
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
