# Update The Installed Skill

Use this procedure when the employee requests a skill update, or to refresh stale guidance as
part of an already authorized launcher update. Do not run it during unrelated business queries.

## Identify The Source And Target

- Official repository: `https://github.com/YinXiaoyu-1998/enterprise-hub-mcp-skill`.
- Installable directory: `skills/enterprise-hub-mcp/`; frontmatter name: `enterprise-hub-mcp`.
- Resolve the repository's default branch (currently `main`) and its current commit SHA. That
  SHA identifies the skill revision; `enterprise-hub-mcp-launcher@...` identifies a separate npm
  package and cannot tell you whether the skill files are current.
- Locate the copy loaded by the invoking agent. Respect an explicitly selected installation
  path. The canonical current-user target is `~/.agents/skills/enterprise-hub-mcp` on
  macOS/Linux-like systems and `%USERPROFILE%\.agents\skills\enterprise-hub-mcp` on Windows.
  Do not create a second copy under `~/.codex/skills` by default. If the host loads a legacy or
  managed location, use its supported update path and verify which copy it will actually load;
  do not claim success after updating a different, inactive copy.

## Retrieve And Replace

1. Fetch a fresh copy into a temporary directory, using available Git or HTTPS tools. For
   example, `git clone --depth 1 https://github.com/YinXiaoyu-1998/enterprise-hub-mcp-skill.git <temporary-checkout>`
   followed by `git -C <temporary-checkout> rev-parse HEAD` retrieves the default branch and
   records its SHA. Without Git, resolve the default branch and SHA through the GitHub API,
   then download the repository archive for that exact SHA. Do not require a marketplace
   entry, GitHub credentials for this public repository, or Enterprise Hub authentication.
2. Read the fetched `skills/enterprise-hub-mcp/SKILL.md` and its update guidance before replacing
   anything. Verify the expected repository, directory, frontmatter name, and referenced files.
   Use files from one commit, not a mix of moving-branch downloads. Do not replace the skill with
   the repository README, a launcher npm package, or a fork discovered by a name search.
3. Compare the complete source skill directory with the active installed copy. If they match,
   report that it is current and make no replacement. Preserve any local customizations in a
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
   replacement or verification fails. Keep the backup until success, remove temporary downloads,
   and report the source repository, commit SHA, installed path, and verification result. If a
   backup remains, state its location outside the skill discovery roots.
6. Reload the host's skill list if supported; otherwise explain that a restart or new task may
   be needed. Distinguish verified files on disk from confirmed loading by the running host.

If network access or local write permission is unavailable, leave the installed copy intact and
report that concrete limitation with the official source link. Lack of a recommended marketplace
listing is not an update failure when Git/HTTPS and the installation path are available.

## Continue Within The Requested Scope

For a skill-only request, finish after the skill refresh and report the launcher separately as
unchanged. If the employee also requested a launcher update, use the exact version approved in
the newly verified skill and its Official Install Or Update procedure, then run self-check.
If the server still recommends a version beyond that official pin, report the mismatch and
defer that unsupported launcher upgrade; do not invent a pin or use npm `latest`.

Older installed skills without this procedure cannot discover it retroactively. Bootstrap them
once by giving the agent the official repository URL and requesting replacement of the installed
`enterprise-hub-mcp` skill from `skills/enterprise-hub-mcp/`. Subsequent requests can simply name
`enterprise-hub-mcp` or `enterprise-hub-mcp-skill`.
