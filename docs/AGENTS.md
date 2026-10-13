# Durable project documentation

- Update `docs/implementation/progress.md` only for durable milestones, merged releases, blockers, recovery audits, and final readiness. Record a handoff only when ownership actually transfers; never use progress or handoff files as transcripts.

- Use existing design/runbook/ADR entrypoints instead of duplicating operational instructions. Local `AGENTS.md` files hold decisions, invariants, commands and links; shared rules have one canonical owner.
- Distinguish approved design, implemented code, published launcher, deployed service and accepted real-tenant cutover. Do not infer one from another or promote stale status text to current fact.
- Ordinary documentation records only current effective behavior or final decisions. When a new document supersedes an old version, consolidate unique still-valid requirements into the current owner, delete the old version and repair references; do not append contradictory amendments or keep stale copies.
- Preserve history only in explicitly historical records: progress, handoffs, ADRs, decision interviews, dated evaluations and history logs. Label them as historical and route operational readers to `docs/README.md`. Never present a historical decision as current authority.
- Keep `CONTEXT.md` as the single current domain glossary. Verify code, approved decisions and release evidence before updating status; an unimplemented final decision must be marked unimplemented, and deployment does not imply tenant activation.
- Validate links and referenced commands; update connected contract/usage documents when public behavior changes. Writing documentation alone does not authorize running the documented operation.
