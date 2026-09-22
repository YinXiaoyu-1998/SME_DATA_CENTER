# Beta User Onboarding Runbook

Last updated: 2026-08-23

This runbook is for the first controlled macOS + Codex beta pilot. It is an operator checklist, not
an employee-facing product page. Do not paste passwords, setup links, tokens, credentials, full
DSNs, or cloud secrets into chat, git, PRs, logs, screenshots, or support notes.

## Pilot Boundary

Use this runbook only for:

- macOS + Codex;
- the official SMEDC skill;
- `smedc-mcp-launcher@0.5.1`;
- browser password setup and Device Authorization login;
- fixture or explicitly approved non-sensitive data.

Windows, OpenClaw, real customer-confidential data, self-service registration, MFA, password-reset
email, and production admin UI are out of scope for the first pilot.

## Information To Collect

Before creating an account, collect:

| Field            | Required | Notes                                                                                   |
| ---------------- | -------: | --------------------------------------------------------------------------------------- |
| beta email       |      yes | user-facing login identifier                                                            |
| display name     |      yes | visible only for operator clarity and audit readability                                 |
| organization     |      yes | existing organization id; current seeded staging default is `default-org`               |
| role             |      yes | explicit `employee` or `admin`; no default                                              |
| clearance        |      yes | explicit integer `0` through `3`; no default                                            |
| first-run data   |      yes | policy choice; fixture or approved non-sensitive document only; see data table below    |
| support owner    |      yes | person who can reset password, revoke access, and coordinate cleanup                    |
| success criteria |      yes | normally: install, login, upload, search, logout/reset; see success-criteria note below |

### Organization Values

`organization` is not a closed enum in the schema; it is an existing `Organization.id`.

For the current staging beta pilot, use `default-org` unless the pilot intentionally creates and
validates a new organization. Do not invent an organization id in the onboarding
command: the operator CLI fails if the organization does not already exist.

### Role Values

`role` is the `EmployeeRole` enum. Current values:

| Value      | Difference                                                                                     | First beta default |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| `employee` | Normal beta user. Role alone does not grant ordinary document reads.                           | yes                |
| `admin`    | May use explicitly declared privileged administrative operations. It does not raise clearance. | no                 |

For the first real beta user, use `employee` and select clearance separately.

### Confidentiality Clearance

Every document and employee belongs to exactly one organization. Ordinary reads require that same
organization and `employee.clearance >= document.confidentialityLevel`; both are integers from `0`
through `3`. Role is independent. Existing accounts migrate to clearance `3`; new accounts must
receive an explicit clearance from the onboarding operator. The service has no labels, store scope,
or personal-document tags.

### First-Run Data Values

`first-run data` is a policy choice, not a database enum:

| Value                               | Meaning                                      | Current first-beta status   |
| ----------------------------------- | -------------------------------------------- | --------------------------- |
| repo fixture                        | committed synthetic fixture file             | allowed                     |
| approved non-sensitive internal doc | real but non-confidential internal test file | allowed with owner approval |
| real customer-confidential data     | customer/private/authoritative business data | not allowed yet             |

### Success Criteria Values

`success criteria` is a pilot checklist, not a database enum. The recommended first-beta checklist
is fixed unless the pilot owner explicitly narrows it:

- install or repair the skill/launcher;
- browser login;
- confirm the current account's role and clearance;
- upload one approved evidence file;
- wait for indexing;
- search from a fresh task;
- logout or password reset/re-login.

## Preflight

From a clean local `main`:

```sh
git fetch origin
git switch main
git pull --ff-only
```

Confirm the public service boundary:

```sh
curl -fsS https://api.smedatacenter.xyz/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' https://api.smedatacenter.xyz/readyz
```

Expected:

- `/healthz` succeeds;
- public `/readyz` returns `404`.

Confirm the local operator environment can reach staging without printing secrets:

```sh
npm run readyz:local
```

Use the documented `.env`/Keychain/runtime secret locations. Never echo or copy secret values.

## Create The Beta Account

Create the employee and one-time password setup link:

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js onboard \
  --org-id <org-id> \
  --email <beta-email> \
  --display-name "<display-name>" \
  --role employee \
  --clearance 0
```

Rules:

- the command prints a one-time browser setup link;
- the setup link itself is valid for 24 hours;
- after the employee opens the setup link, the password setup form session is valid for 10 minutes;
- deliver that link only through a trusted private channel;
- do not paste the full link into chat, docs, issues, PRs, or logs;
- the employee sets their password only on `https://api.smedatacenter.xyz`.

For a synthetic dry run, use only `manual-full-flow-<run-id>@example.invalid` or another documented
test-only identity that can later be hard-deleted.

## Employee Install And Login

The employee should ask their agent naturally, for example:

> 帮我安装并登录 SMEDC，我要用它查公司的资料。

The agent must follow `skills/smedc-mcp/SKILL.md`:

- install `smedc-mcp-launcher@0.5.1` into the current-user versioned directory;
- configure a local stdio MCP entry named `smedc`;
- set only `SMEDC_BASE_URL=https://api.smedatacenter.xyz`;
- call `smedc_login` if authentication is required;
- let the browser collect the employee email/password on the SMEDC sign-in page;
- never request or receive the password in chat.

Login timing:

- `smedc_login` starts Device Authorization and opens its first-party verification link in
  the system browser;
- the employee enters their email and password there, not in the agent chat;
- that browser login transaction is valid for 10 minutes;
- if the employee waits longer than 10 minutes, the page expires and the agent should call
  `smedc_login` again instead of reusing the old page;
- the launcher polls the token endpoint over its back channel and never asks the employee or agent
  to relay an authorization code or token;
- normal access tokens last 10 minutes, and the launcher refreshes them using its operating-system
  secure-store durable credential.

Verification from a new Codex task:

```text
帮我看看 SMEDC 现在登录了吗，账号的身份和保密等级是什么？
```

Expected:

- authenticated status;
- the intended role and clearance.

## First Evidence Upload/Search

Use a fixture or approved non-sensitive file. The employee prompt should remain natural:

```text
帮我把这份资料放进 SMEDC，之后大家能查到。
```

Acceptance checks:

- agent reads exact file bytes and uploads through MCP;
- an omitted upload confidentiality level is stored as `0`, and an explicit level is an integer
  from `0` through `3`;
- evidence document status eventually becomes ready/active;
- a new task can search for the uploaded content through MCP;
- no cross-organization or above-clearance data is exposed.

## Structured Data Pilot Rules

Structured tables are allowed in the first pilot only when the agent keeps the upload/query context.

After uploading a table, the agent must retain or rediscover:

- import batch id;
- dataset id;
- declared business-date window;
- enterprise/store name if present;
- confidentiality level used for the upload.

The agent should call dataset discovery before structured queries and use only `canonicalName`
fields. When the employee asks what data is available, the agent may use
`describe_structured_dataset_coverage` to show readable applied source windows or snapshots, but it
must not treat coverage as a completeness guarantee or infer hidden sources from missing entries.

For follow-up questions such as “这份表一共有多少条记录？” the agent must query SMEDC MCP
with that context. It must not answer by reading the local CSV unless the employee explicitly asks
for local-file inspection.

If the agent cannot determine which uploaded table/window the employee means, it should ask one
short clarification before querying all accessible historical rows.

Recommended first structured prompt sequence:

```text
这份菜品销售表帮我传进去。
```

then, in a fresh task if testing persistence:

```text
查一下我刚传到 SMEDC 的那份菜品销售表，一共有多少条记录，销售额加起来是多少，销售额最高的两个菜是什么？
```

## Reset, Logout, And Re-Login

Employee-initiated logout:

```text
帮我退出 SMEDC。
```

Operator password reset:

```sh
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js reset-password --employee-id <employee-id>
```

Rules:

- the reset command prints a new one-time browser setup link;
- password reset must revoke old launcher sessions;
- after reset, the employee logs in again through browser login, not by sharing a password with the
  agent.

## Cleanup

For synthetic test users, remove uploaded documents, structured rows/import batches, Qdrant points,
OSS objects, sessions, identities, and the employee account. The official manual acceptance
runner and `delete-test-account` command cover the narrow `manual-* @example.invalid` cleanup path:

```sh
npm run test:official-manual -- cleanup --run-id=<run-id>
docker compose --profile release --env-file /opt/smedc/runtime.env \
  -f /opt/smedc/docker-compose.yml run -T --rm release-ops \
  node dist/release/auth-operator.js delete-test-account \
  --email manual-full-flow-<run-id>@example.invalid \
  --confirm-email manual-full-flow-<run-id>@example.invalid
```

The operator CLI ships compiled as `dist/release/auth-operator.js` in the release-ops image and
always runs against the staging runtime env; never point `npm run auth:operator` (the local
entrypoint) at staging from the local development `.env`.

For a real beta user, do not hard-delete the account or data unless the pilot owner explicitly
approves the deletion scope. Record whether data should be retained for debugging, archived, or
purged.

## Stop Conditions

Stop the pilot and diagnose before proceeding if:

- the browser asks for credentials outside `https://api.smedatacenter.xyz`;
- an agent asks the employee to paste a password, token, setup link, authorization code, or raw
  header into chat/config/env;
- public `/readyz` becomes reachable;
- unauthenticated MCP calls succeed;
- a user can see data outside their organization or above their clearance;
- uploaded fixture/test data cannot be cleaned up;
- structured queries answer from a local file when the request is about SMEDC data.

## Before Real Customer Data

Do not upload real customer-confidential or production-authoritative data until the remaining
real-data gates in `beta-access-readiness.md` are complete: recovery drill, minimal alerts,
application rollback drill, data retention/deletion policy, RDS lifecycle decision, and dependency
audit triage.
