# Optional enterprise workflows

Use this reference when installing SMEDC, choosing automatic tasks, recovering a paused workflow,
or moving to another computer. This core skill owns official launcher installation/update/login;
[`smedc-workflows`](https://github.com/YinXiaoyu-1998/smedc-companion-skills/tree/main/skills/smedc-workflows)
owns selected workflow dependencies, host scheduling, execution and migration.

Core setup may introduce three independent options: daily Meituan ingestion, Meituan/Dianping
review operations, and natural-week business reports. Report each installed/not-installed/blocked
state. Do not silently install business dependencies or create tasks during basic setup, login or
ordinary queries. A selected workflow request authorizes its required dependency installation;
follow its complete-subtree comparison and recovery procedure, preserving newer local changes.

First establish official authentication. Without an account, direct the administrator to the
operator for provisioning; users sign in and set passwords on the official page. Never ask for
passwords in chat or create accounts/roles through a workaround. Current admin is required for
workflow configuration, installation and runs; business content still needs its own grants.

The versioned workflow feature requires the companion manifest's compatible launcher/service.
Launcher `0.16.0` is published, independently verified and approved for installation, including
workflow tools and explicit order scope. Install it through this core skill's exact-pin procedure;
then verify live service capability and current administrator authorization before workflow setup.
If capability is unavailable, report that service gap. Do not substitute `latest`, raw JSON-RPC
or a separate credentialed HTTP client.

When compatible official tools exist, call `list_enterprise_workflows` to verify live service
capability/version and obtain the authenticated enterprise catalog and official settings entry.
Do not infer readiness from tool discovery, construct organization URLs or demand JSON from the
administrator. Open the returned “自动任务” entry, reuse existing settings, and let the user inspect
precise store mappings, recipients, standing authorizations, named groups and changes. Saving a
paused draft or migration must not activate execution or a new order-scope requirement.

The official tool family is list/get/prepare/save enterprise workflow, manage workflow installation,
manage workflow run, record workflow action, and get workflow status. Configuration changes use
server previews plus expected configuration/integration/control versions. Read the actual matching
schemas; do not invent operations or arbitrary payload fields. The companion owns the bounded
installation, lease, action, recovery and migration recipes.

Shared mapping previews identify affected task types and stores; a dependent configuration change
requires a fresh preview. After pause/reactivation or explicit takeover, resume the original run ID
with the current verified assignment/control binding returned by the service. Its original window
and snapshot remain fixed. Restrictive settings apply before the next new action and accumulate
for unfinished runs; later expansion applies to a new run. Follow the companion's recovery recipe.

First release supports macOS, Codex standalone local cron, IAB and authorized Gmail. Lack of
Meituan login does not block basic SMEDC. Lack of Gmail does not block local report generation.
Preparation checks and first real-run verification are separate; do not send test mail or publish
customer replies merely to test setup. Scheduled runs do not update their own package.

A replacement computer reads existing central enterprise/store/mail/group/authorization settings
and confirmed receipts; only its local login, browser/mail connection, workspace and host task are
new. It does not re-onboard the enterprise. Old-machine takeover and private three-task migration
require the companion's source-bound preview, complete paged receipt import/readback, explicit
assignment handoff and host readback. Do not replace or pause existing tasks during development
or package installation. Unknown external results remain blocked for reconciliation, never replayed
because a task ID or computer changed.

New workflow in-store uploads explicitly declare `settled_only` only with the compatible released
contract. Old published clients remain on their documented compatibility path until explicit cutover;
never omit the new field to bypass a workflow requirement, infer historical order scope, modify an
original workbook or treat a missing store/day as zero.
