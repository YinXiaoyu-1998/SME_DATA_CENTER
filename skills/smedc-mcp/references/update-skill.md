# Update The Installed Skill

Use this procedure when the employee requests a skill update, or to refresh stale guidance as
part of an already authorized launcher update. Do not run it during unrelated business queries.

## Identify The Source And Target

- Official repository: `https://github.com/YinXiaoyu-1998/smedc-mcp-skill`.
- Installable directory: `skills/smedc-mcp/`; frontmatter name: `smedc-mcp`.
- Resolve the repository's default branch (currently `main`) and its current commit SHA. That
  SHA identifies the skill revision; `smedc-mcp-launcher@...` identifies a separate npm
  package and cannot tell you whether the skill files are current.
- Locate the copy loaded by the invoking agent. Respect an explicitly selected installation
  path. The canonical current-user target is `~/.agents/skills/smedc-mcp` on
  macOS/Linux-like systems and `%USERPROFILE%\.agents\skills\smedc-mcp` on Windows.
  Do not create a second copy under `~/.codex/skills` by default. If the host loads a legacy or
  managed location, use its supported update path and verify which copy it will actually load;
  do not claim success after updating a different, inactive copy. Inventory other host-discovered
  copies, including `~/.codex/skills`, configured project/managed roots, and backup folders. Resolve
  symlinks so aliases to the same directory are not mistaken for independent installations.
  Remove obsolete duplicate copies after the canonical replacement is verified; first repoint
  in-scope hosts that depend on them. If a host requires a separate managed copy, update it through
  its supported mechanism and verify identical source content. Never delete repository source
  checkouts or unrelated skills. An inaccessible or conflicting copy is a reported blocker, not
  evidence that every installed copy is current.

## Retrieve And Replace

1. Fetch a fresh copy into a temporary directory, using available Git or HTTPS tools. For
   example, `git clone --depth 1 https://github.com/YinXiaoyu-1998/smedc-mcp-skill.git <temporary-checkout>`
   followed by `git -C <temporary-checkout> rev-parse HEAD` retrieves the default branch and
   records its SHA. Without Git, resolve the default branch and SHA through the GitHub API,
   then download the repository archive for that exact SHA. Do not require a marketplace
   entry, GitHub credentials for this public repository, or SMEDC authentication.
2. Read the fetched `skills/smedc-mcp/SKILL.md` and its update guidance before replacing
   anything. Verify the expected repository, directory, frontmatter name, and referenced files.
   Use files from one commit, not a mix of moving-branch downloads. Do not replace the skill with
   the repository README, a launcher npm package, or a fork discovered by a name search.
3. Compare the complete source skill directory with the active installed copy. If they match,
   skip replacement but still check host loading and remove obsolete duplicates/backups before
   reporting completion. Preserve any local customizations in a
   backup; if a known newer installation or conflicting managed/local customization would be
   overwritten, resolve that specific conflict before replacing it. Do not blindly downgrade
   or overwrite local work based solely on an older launcher pin.
4. Stage the complete skill directory, including `agents/` and all bundled references, scripts,
   and assets that exist in the selected revision. Back up the previous target outside every
   host-discovered skill directory, then replace only the target skill directory. Avoid overlay
   copying that leaves obsolete files behind. Preserve unrelated skills and host configuration;
   do not alter launcher installations or secure-store sessions during a skill-only update.
5. Verify installed relative file paths and bytes against the selected source directory, reopen
   the installed `SKILL.md`, and check its relative references resolve. Restore the backup if
   replacement or verification fails. Keep the backup only until replacement and host loading
   are verified, then remove that update-created backup and temporary downloads. Report the
   source repository, commit SHA, installed path, and verification result. If a
   backup remains because the update is incomplete, state its location outside discovery roots
   and the outstanding action. Do not retain obsolete discoverable backups as fallback skills.
6. Reload the host's skill list if supported; otherwise explain that a restart or new task may
   be needed. Confirm the host actually loads the verified path/revision and no obsolete copy
   shadows it, then finish backup/duplicate cleanup. Distinguish verified files on disk from
   confirmed loading by the running host; if the latter is unverified, report pending reload,
   not a completed update. Only remove historical backups with verified SMEDC-only contents and
   no unique user changes; report ambiguous remnants instead of deleting unrelated material.

If network access or local write permission is unavailable, leave the installed copy intact and
report that concrete limitation with the official source link. Lack of a recommended marketplace
listing is not an update failure when Git/HTTPS and the installation path are available.

## Continue Within The Requested Scope

This revision approves exactly `smedc-mcp-launcher@0.7.1`. Its upload tools stay visible but
require an active admin. Preserve the `UPLOAD_ADMIN_REQUIRED` nonretryable handling and the
before-file-access role check when refreshing guidance; an update never grants upload permission
or changes an account's clearance. Future revisions must supply their own verified exact pin.

For a skill-only request, finish after the skill refresh and report the launcher separately as
unchanged. If the employee also requested a launcher update, use the exact version approved in
the newly verified skill and its Official Install Or Update procedure, then finish
[upgrade, restart, and cleanup](upgrade-cleanup.md). This also applies to a general SMEDC update
or a request to keep only the latest version; do not stop after a successful standalone self-check.
If the server still recommends a version beyond that official pin, report the mismatch and
defer that unsupported launcher upgrade; do not invent a pin or use npm `latest`.

Older installed skills without this procedure cannot discover it retroactively. Bootstrap them
once by giving the agent the official repository URL and requesting replacement of the installed
`smedc-mcp` skill from `skills/smedc-mcp/`. Subsequent requests can simply name
`smedc-mcp` or `smedc-mcp-skill`.
