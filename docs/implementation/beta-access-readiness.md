# First Beta User Readiness

Last verified: 2026-09-22 (historical acceptance evidence below); current guidance updated 2026-09-26.

Current upload policy requires active `admin` for evidence, structured data (including Delivery
Ledger), and quarantine certificates. Employee c0/c3 may read eligible data but cannot upload;
admin c0 may explicitly upload higher-level files without gaining ordinary read access. Tools stay
visible. Direct HTTP upload endpoints return HTTP `403`; MCP JSON-RPC transport returns HTTP `200`
with `isError: true` in the tool result. Both carry `UPLOAD_ADMIN_REQUIRED`,
`File upload requires the admin role.`, and `retryable: false`. This requires an admin, not
re-login, retry, or a clearance change. Launcher 0.6.0 preflights before local
file access and creates no backend audit; backend denial best-effort records `file_upload.denied`.
The [current endpoint matrix](api-contract.md#file-upload-capability) governs new pilots. Previous
full-flow results below remain historical evidence. The three-account admin-only upload gate passed
on 2026-09-24; launcher 0.6.0 and the synchronized backend were deployed and received focused public
acceptance on 2026-09-26. The full user-visible workflow was not repeated for this i18n/auth cleanup.

This document tracks whether SMEDC is ready for a first controlled beta user. It replaces
the withdrawn 2026-07-23 beta-token bridge snapshot; do not use any design that asks a user or
agent to handle passwords, JWTs, opaque tokens, refresh credentials, or raw HTTP headers.

“Real beta user” and “real customer data” remain separate gates. A real beta user may test the
live staging service with fixture or explicitly approved non-sensitive business documents before
the project is ready to ingest customer-confidential or authoritative production data.

## Current Answer

The first pilot scope is a **controlled macOS + Codex beta pilot with non-sensitive data**.
The admin-only backend deployment and focused role/clearance acceptance gate have passed, so this
controlled pilot may proceed without repeating the unchanged full workflow.

It is **not yet ready for real customer data**. Recovery, alerts, retention/deletion policy, and
selected operational drills still need owner approval and evidence before customer-confidential
data is uploaded.

Windows desktop and user-visible OpenClaw/phone-controlled flows are intentionally not blocking the
first macOS + Codex pilot. Linux launcher installation is supported separately, with headless
Device Authorization and memory-only custody when no secure store is available; a particular
phone-controlled OpenClaw-family product still needs its own end-to-end acceptance.

## Verified Current Facts

| Boundary              | Current evidence                                                                                            | Result                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Public service        | `https://api.smedatacenter.xyz/healthz`                                                                     | `200`                                                                                                                                     |
| Private readiness     | public `GET /readyz`                                                                                        | `404`, as designed; readiness remains internal only                                                                                       |
| Official identity     | browser password setup/login, OAuth Device Authorization, rotating durable credentials                      | deployed to staging; the former Authorization Code + PKCE and loopback callback paths are removed                                         |
| Development auth      | old dev email/JWT login and staging JWT secret                                                              | removed from staging runtime/GitHub/local Keychain                                                                                        |
| Public MCP            | unauthenticated public `/mcp`                                                                               | rejects unauthenticated requests; authenticated launcher calls succeed                                                                    |
| Launcher package      | public npm package `smedc-mcp-launcher@0.6.0`                                                               | exact install, native macOS/Windows package acceptance, registry integrity, packaging, and audit pass.                                    |
| Linux launcher        | XDG current-user install, no-display package load, Device Authorization link delivery, memory-only fallback | supported; headless login-to-business-tool loop passed, while each user-visible OpenClaw-family host remains a separate client acceptance |
| macOS Codex client    | 0.1.x user-visible flow plus 0.3.0 native package acceptance                                                | passed at those scopes; full user-visible 0.3.0 rerun is not yet recorded                                                                 |
| Full macOS Codex flow | fresh synthetic account, 11 natural user-visible Codex sessions, upload/search/query/logout/reset/re-login  | passed core auth/evidence lifecycle; structured-query usability observations remain                                                       |
| Cleanup               | manual acceptance cleanup                                                                                   | removed run documents, import batch, Qdrant points, dish rows, identity, employee, session                                                |
| Deployment            | GitHub `main` quality gates and staging deploy workflow                                                     | launcher 0.6.0 synchronization and version-gate hotfix deployed at immutable tag `be4c610b1992`                                           |
| Runtime               | API/worker/Qdrant/nginx/TLS/RDS/OSS                                                                         | healthy in the latest verified live checks                                                                                                |
| RDS backup            | 7-day full backup retention and 7-day log backup                                                            | backup exists; restore has not been rehearsed                                                                                             |
| RDS transport         | private VPC TCP; provider SSL disabled                                                                      | current staging fact; final SSL policy remains open                                                                                       |
| RDS lifecycle         | prepaid RDS expiry and deletion-protection facts recorded in staging readiness                              | human renewal/protection decision still required before customer data                                                                     |

The headless Linux login-to-business-tool loop remains compatibility evidence, and the launcher
release workflow now installs and loads the pinned artifact under no-display Ubuntu. This does not
substitute for user-visible phone/OpenClaw acceptance on a particular product host.

## First Pilot Scope

The recommended first pilot is:

- one real beta user with role `employee`, plus a separate active `admin` account for positive uploads;
- macOS + Codex only;
- official skill installation and `smedc-mcp-launcher@0.6.0`;
- browser password setup and Device Authorization login only;
- fixture or explicitly approved non-sensitive documents;
- one organization and explicitly assigned clearance for each account;
- employee upload denial, admin evidence upload/indexing, and authorized employee search as the primary workflow;
- structured CSV upload by the active admin and query by the employee only with the tightened
  skill guidance and explicit date/import context.

The beta user keeps the `employee` role; do not promote the user or raise clearance to make an
upload succeed. An authorized admin supplies the data. The synthetic acceptance gate separately
uses employee c0, employee c3, and admin c0 to prove that eligible high-clearance reads do not
grant upload permission and explicit above-clearance admin uploads do not grant ordinary reads.

The first pilot should avoid real customer-confidential data, broad multi-user rollout, Windows,
OpenClaw, admin UI, MFA, self-service registration, and automated password-reset email.

## Remaining Before Inviting The First macOS + Codex Beta User

| Item                            | Status                | Why it matters                                                                                                                           |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Beta onboarding runbook         | covered by this slice | The operator needs one repeatable path for account creation, setup-link delivery, verification, reset, and deletion.                     |
| Skill structured-query guidance | covered by this slice | Manual acceptance showed low-technical prompts like “this table” can cause an agent to answer from a local CSV or query historical rows. |
| Role-boundary acceptance        | passed 2026-09-24     | Three-account staging acceptance covered employee c0/c3 denial, admin c0 uploads, and unchanged ordinary-read controls.                  |
| Actual beta identity details    | needed per user       | Operator needs email, display name, role, organization, and explicit 0–3 clearance for the beta employee and uploading admin.            |
| First-run data approval         | needed per pilot      | Decide whether the user uses repo fixtures, synthetic internal docs, or a specific non-sensitive real document.                          |
| Support owner/contact           | needed per pilot      | Someone must own setup-link delivery, first-login support, reset, and cleanup during the pilot.                                          |

No additional ACR, SSH, RDS password, OSS key, domain, TLS, GitHub Actions secret, npm token, or
JWT secret is required for the first macOS + Codex pilot.

## Known Product/UX Observations From Manual Acceptance

1. A vague structured prompt such as “this table” may lead an agent to inspect a locally attached
   CSV instead of calling SMEDC. The skill must instruct employee-owned agents to use
   SMEDC MCP for SMEDC questions, and to treat local files only as upload inputs
   unless the employee explicitly asks for local-file inspection.
2. An unbounded structured query can return older authorized rows from the same dataset. For
   recently uploaded tables, the agent should bind follow-up questions to the import result,
   declared business-date window, enterprise name, or other returned metadata; if that context is
   absent, it should ask a short clarification instead of querying all historical data.
3. Evidence search should continue to use explicit filters such as label and, when testing a fresh
   upload, returned document ids. This avoids matching historical fixture uploads while still
   proving the new upload was indexed and searchable.

These observations are not security bypasses: backend authorization continued to enforce employee
scope. They are beta-readiness usability issues because a low-technical user expects “刚上传这份表”
to refer to that upload, not all accessible history or an agent-side local shortcut.

## Human Inputs Required For The First Beta User

| Input                  | Why it is needed                            | Recommended default                                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| Beta email             | login identity and setup-link recipient     | real beta email                                                           |
| Display name           | operator clarity and audit readability      | real name or agreed nickname                                              |
| Organization           | backend tenant boundary                     | current staging org, unless a new org is intentional                      |
| Role                   | backend authorization role                  | `employee`                                                                |
| Uploading admin        | separate identity for positive uploads      | active `admin` in the same organization; explicit clearance               |
| Clearance              | ordinary document/query visibility          | explicit integer 0–3 for each account; no upload permission               |
| First-run data class   | prevents accidental customer-data upload    | fixture or approved non-sensitive internal document                       |
| Support/reset contact  | account setup and recovery during the pilot | repository operator                                                       |
| Pilot success criteria | determines whether the pilot is done        | install/login, employee denial, admin upload, employee read, logout/reset |

## Before Real Customer Data

The following are not blockers for a fixture/non-sensitive first pilot, but they are blockers before
customer-confidential or production-authoritative data is uploaded:

- approve RPO/RTO and rehearse at least one restore/recovery path;
- configure minimal uptime, disk, worker-failure, and RDS-expiry alerts;
- run one controlled application rollback drill;
- record retention/deletion policy for originals, derived rows, vectors, and audit records;
- decide RDS renewal/deletion-protection policy;
- triage the root dependency audit separately from the clean launcher install audit and passing
  fixable-critical image scan;
- decide whether RDS SSL policy should change from private VPC TCP to provider SSL enforcement.

## Pilot Acceptance Gates

A first macOS + Codex beta pilot passes only when:

- the beta user installs or repairs the skill/launcher without seeing command-line internals as a
  required manual step;
- account password setup and login occur only in the SMEDC browser page;
- a one-time setup link may appear only in the current private human-agent conversation for direct
  handoff;
- setup links never appear in a public/shared chat, config, git, files, issues, PRs, logs, or
  reports;
- no password, token, credential, header, or full DSN appears in chat or durable artifacts;
- the launcher stores durable authentication in the operating-system secure store;
- a new Codex task can confirm the current account's role/clearance and call SMEDC MCP tools;
- the employee upload request is denied before local file reading or transformation; tools remain
  visible. Direct HTTP upload endpoints return HTTP `403`; MCP JSON-RPC transport returns HTTP `200`
  with `isError: true` in the tool result. Both carry `UPLOAD_ADMIN_REQUIRED`,
  `File upload requires the admin role.`, and `retryable: false`, with no re-login, retry,
  or clearance workaround;
- a separate active admin uploads the fixture or approved non-sensitive evidence and confirms
  indexing with the permitted status path; the employee searches from a fresh task, with the
  same organization and adequate clearance, and receives only authorized evidence;
- any structured file is uploaded by the active admin; the employee's follow-up query is scoped
  to that upload/window or asks for clarification, and follows ordinary organization/clearance rules;
- the synthetic three-account acceptance proves employee c0/c3 cannot upload, admin c0 can
  explicitly classify above its clearance, employee c3 can read eligible data, and admin c0 cannot
  bypass ordinary high-level read authorization;
- logout and operator password reset revoke old access;
- pilot test data can be deleted or clearly retained under the agreed policy.
