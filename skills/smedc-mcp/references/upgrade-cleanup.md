# Upgrade, Restart, And Remove Superseded Clients

Read this procedure before any launcher update or old-version cleanup. An upgrade is complete
only when the approved version is running through the host's native MCP connection and the
superseded installations, processes, and entries in scope are gone. Installing a package or
passing a standalone self-check is not completion.

## Scope And Target

- A request to update SMEDC includes refreshing this skill, updating the launcher, reconnecting
  the invoking host, and cleaning its superseded SMEDC components. A skill-only request follows
  [update-skill.md](update-skill.md) and does not change launcher installations or MCP sessions.
- A request to remove all old SMEDC versions or keep only the latest also covers safely
  discoverable SMEDC integrations belonging to the current OS user. Migrate their existing
  entries to the approved launcher; remove duplicate entries and disable verified obsolete
  autostarts. Do not install new hosts or companion skills. A request naming only one host stays
  limited to that host; an old version used elsewhere is a reported cleanup blocker.
- First fetch and verify the official default-branch skill revision. Its exact launcher pin is
  the target. “Latest” never means npm `latest` or a version inferred from server metadata. If
  the official source is unavailable, or its pin conflicts with a known newer official install
  or server requirement, report the mismatch and do not downgrade or delete the working install.
- Keep valid secure-store sessions. Updating does not require logout, credential deletion, or
  account deletion. Memory-only sessions require browser login again after restart.

## 1. Inventory Before Changing Anything

Record only non-secret facts, using the host's supported configuration interface:

- Every in-scope SMEDC MCP entry, including aliases, user/project overrides, direct remote entries,
  and `npx` or global-package commands. Identify SMEDC by its verified package/path/service origin,
  not just by an entry's name. Never dump whole configurations, process environments, or tokens.
- The skill locations the hosts actually load, including legacy locations and backup folders
  inside discovery roots. Resolve symlinks before classifying distinct copies. Follow the skill
  update procedure for replacement and deduplication.
- Installed launcher versions in the platform directory, plus legacy installs, wrappers, or
  package-manager locations referenced by those entries. Use package metadata to verify identity
  and version. Check a current-user global prefix or isolated `npx` installation if discovered;
  do not search or wipe unrelated package caches.
- Launcher process owner, PID, parent PID, start time, and resolved launcher path/version, plus
  any supervisor that can respawn it. Inspect narrowly with OS process tools: `ps` on macOS/Linux
  or `Get-CimInstance Win32_Process` on Windows. Filter locally and redact secret arguments before
  exposing results. Several hosts may legitimately run separate processes of the same new version.

Back up only affected configuration and skill files, with restricted permissions, outside skill
discovery roots. Track the exact temporary paths for cleanup; never print backup contents.
If ownership, a managed installation, or a local customization cannot be resolved, report that
specific blocker before deleting or overwriting it. Never claim a machine-wide inventory from
checking only the invoking host.

## 2. Prepare And Check The New Launcher

Use Official Install Or Update in `SKILL.md` to install the exact pin into its versioned directory.
If the exact package is already present and healthy, reuse it and still complete the remaining
checks. Run its `--version` and `self-check`; verify version, origin, server compatibility, and
reachability. A supported memory-only secure-store result is not an error. Stop on a failed
check before removing the old installation or changing working entries.

## 3. Switch Configuration And Stop Old Processes

Finish or safely cancel affected SMEDC operations before reconnecting; do not interrupt uploads
and then replay them blindly. Use each in-scope host's supported MCP configuration mechanism to
retain one effective `smedc` stdio entry with the new absolute path, `serve`, and the sole
`SMEDC_BASE_URL` value. Remove verified duplicate/legacy SMEDC entries, including shadowing
overrides and remote/npx alternatives. Preserve all unrelated entries and settings.

Stop/disconnect the affected MCP connection through its owning host, then reload/reconnect it.
If only a host restart is supported, restart that host. Changing a config file, running
`mcp remove/add`, or opening a new chat is not proof that an existing launcher process stopped.
The launcher itself has no `stop` or `restart` CLI command; use the owning host or the verified PID procedure below.
Disable or update an obsolete SMEDC-only supervisor/autostart before terminating its child;
never disable an entire shared agent runtime just to remove a launcher autostart.

Reinspect the inventory. For a remaining old launcher, verify the current user, exact package
path, PID, parent, and start time again immediately before termination to avoid PID reuse. Prefer
the owning runtime's stop operation; otherwise send SIGTERM to that individual PID on macOS/Linux
and wait a bounded interval (for example, 10 seconds). If it still remains, revalidate identity
before SIGKILL. On Windows, prefer host shutdown, then use `Stop-Process -Id` only for the
revalidated launcher PID and verify exit. Never use `killall node`, broad `pkill` patterns,
`taskkill /IM node.exe`, or indiscriminate process-tree termination. If it respawns, resolve its
owning configuration/supervisor instead of repeatedly killing it.

If restarting would terminate the agent doing this work and no supported reconnect is available,
give the employee the exact host restart action and the remaining verification steps. Mark the
upgrade **pending restart and verification**. Resume at the inventory checks after restart;
do not claim success or discard recovery files prematurely.

## 4. Prove The Host Uses The New Version

Re-read effective MCP configuration and inspect the newly connected host's native tool list.
Verify its negotiated server version if the host exposes it; otherwise correlate the new
launcher PID/start time and resolved package path with that host's re-established connection.
Both must identify the approved version. A config path or separately executed `--version` /
`self-check` alone cannot prove the version of the host's existing connection. Do not invent a
version tool or hand-craft JSON-RPC to obtain this evidence.

Call `smedc_auth_status` through the new native connection. Follow normal browser login when
required; never access the secure store directly. If native tools are unavailable, the connection
cannot be correlated, or a host still uses an old launcher, report **verification incomplete**.
Do not describe a standalone self-check as host verification.

## 5. Remove Superseded Files

After the new connection is verified, remove each superseded launcher installation only after
confirming no configuration, process, wrapper, or autostart still references it. If another host
references it, migrate/reconnect that host when in scope; otherwise report the blocking host and
do not delete its files. Do not leave an old active integration as a successful upgrade outcome.

Delete exact verified old version directories, duplicate skill installations, obsolete SMEDC-only
wrappers, and isolated legacy launcher caches. For a verified current-user global installation,
use its package manager to uninstall only the launcher package after all references are migrated.
If a cache directory also contains unrelated packages, preserve it and report the limitation;
never run a blanket npm-cache purge. Check resolved paths and symlink targets before deletion;
unlink an obsolete alias without following it into the current installation. Never delete an
entire data-home, shared npm prefix, skill root, Node.js/npm, credentials, or business files.

Remove temporary downloads and backups created for this successful update. Remove older backup
copies only when verified to contain superseded SMEDC material with no unique user changes;
preserve mixed/unrelated backups and report unresolved remnants. Do not retain old launchers as
permanent fallback versions. On failure, keep recovery files outside discovery roots and report
the incomplete state; restoring an old configuration is recovery, not a successful upgrade. Restore only the affected
SMEDC settings if other configuration has changed since the backup; never overwrite newer
unrelated settings with a whole-file restore.

## Completion Report

Repeat the scoped inventory after cleanup. Report the official skill commit and loaded path,
approved launcher version, host connection evidence, removed old versions/entries/processes,
and remaining blockers. Claim **complete** only when the in-scope hosts load the verified skill
and launcher, no old launcher processes or effective entries remain, and superseded files and
update-created temporary backups are removed. State the inspected scope. Any inaccessible host,
remaining old installation, required restart, or unverified skill reload means **incomplete**,
with the exact next action; do not silently widen permissions or report “no remnants” without proof.
