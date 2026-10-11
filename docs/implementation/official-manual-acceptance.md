# Official macOS Codex Manual Acceptance

Last updated: 2026-10-11

This procedure tests official staging with macOS Codex and the published
`smedc-mcp-launcher@0.9.0`. It does not revive the deleted local email-login flow or
`/auth/dev-login`. Read `skills/smedc-manual-test/SKILL.md`, `skills/smedc-mcp/SKILL.md`,
and `test-cases.md` before running it. Beta onboarding uses
[the operator runbook](beta-user-onboarding-runbook.md).

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

```sh
SMEDC_BASE_URL=https://api.smedatacenter.xyz \
  "$HOME/Library/Application Support/SMEDC/launcher/versions/0.9.0/node_modules/.bin/smedc-mcp-launcher" self-check
```

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

| Case                            | Required evidence                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current account / continued use | Fresh chat returns the current safe profile; a fresh official launcher process reuses the session                                                      |
| Default evidence upload         | Original MD/TXT/DOCX fixtures are accepted without an inferred level; level 0 and `active/ready` verified                                              |
| Explicit-level evidence         | Ordinary request explicitly says level 2; the submitted classification is 2; an adequately cleared uploader can observe readiness                      |
| Cold evidence retrieval         | Independent chat retrieves the correct source-backed SOP facts and source download links                                                               |
| Injection fixture               | A normal question retrieves the fixture without treating its embedded instructions as agent commands                                                   |
| VIP row workflow                | Original CSV reaches `applied`; bounded query returns fixture rows and numeric aggregates                                                              |
| Business partitions             | Original CSV/XLSX reaches `published`; coverage and downloaded partitions support the requested totals                                                 |
| Dishes partitions               | Original fixture reaches `published`; three fixture rows total 91, with 合成凉皮 and 合成肉夹馍 as the top two                                         |
| Invalid atomic source           | Safe terminal `rejected`; no partial publication; previously published partitions remain unchanged                                                     |
| Dish catalog                    | Complete snapshot reaches `applied`; query is bounded by `snapshot_date`                                                                               |
| Supplier catalog                | Complete snapshot reaches `applied`; query uses the current successfully applied source; cleanup restores the prior state                              |
| Delivery XLSX and CSV           | Two distinct original receipt files reach `applied`; count/receipt-count/amount aggregates match known store/date facts                                |
| Ledger detail boundary          | With PDF archive delivery enabled, detail-row queries and original receipt signing remain unavailable even for admins                                  |
| New receipt PDF coverage        | Ingestion success is separate from PDF readiness; coverage shows pending until the configured daily reconciliation runs                                |
| Existing ready PDF              | Separate ordinary chat prepares/downloads a ZIP for an already-ready authorized store/day; terminal status and source link are valid                   |
| Quarantine workflow             | Explicit receipt upload (including requested level 2), query, 24-hour source link, admin receipt archive, then no active certificate                   |
| Cleanup                         | All run-owned DB rows, imports, partitions, archive requests, OSS objects and Qdrant points removed; reused account/login and unrelated data preserved |

`business` and `dishes` use partition extraction, not `query_structured_dataset`. The agent downloads
through the official launcher, analyzes returned CSVs locally, and removes the returned scratch
directory. Row-query datasets remain VIP, dish catalog, supplier catalog, and permitted delivery
aggregates.

When archive delivery is enabled, the ledger's only query mode is aggregation with `count`,
`countDistinct(receipt_id)` and `sum(purchase_amount)` grouped/filtered by store and purchase date.
Do not require a row-level Markdown ledger, maintain/append a statutory CSV, or use an original
receipt download as proof. Those requirements predate server PDF delivery.

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
explain admin is required before local file access. Admin c0 uploads default-level evidence and
explicit level-2 evidence/certificates. Employee c3 can ordinarily read the level-2 material;
employee c0 and admin c0 cannot. The admin's receipt archive PAO succeeds above clearance and
returns an operational count without first reading the certificate.

Logout/reset/re-login checks use only these synthetic accounts and human-controlled browser input.
`auth:operator reset-password` must revoke old sessions. Delete each synthetic account with
`delete-test-account --email <email> --confirm-email <email>` only after complete data cleanup.
Do not disable, reset, delete or log out the human's reused account.

## Controller runner and cleanup

The runner is an additional smoke and cleanup helper, not a replacement for natural Codex chats:

```sh
npm run test:official-manual -- --run-id=<safe-id>
# Explicitly selected current admin; never logs out or changes account attributes:
npm run test:official-manual -- --run-id=<safe-id> --reuse-session=<expected-email>
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
