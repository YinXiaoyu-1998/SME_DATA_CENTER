# Durable project documentation

- Update `docs/implementation/progress.md` only for durable milestones, merged releases, blockers, recovery audits, and final readiness. Record a handoff only when ownership actually transfers; never use progress or handoff files as transcripts.

- Use existing design/runbook/ADR entrypoints instead of duplicating operational instructions. Local `AGENTS.md` files hold decisions, invariants, commands and links; shared rules have one canonical owner.
- Distinguish approved design, implemented code, published launcher, deployed service and accepted real-tenant cutover. Do not infer one from another or promote stale status text to current fact.
- Before changing domain language or permission behavior, compare `CONTEXT.md`, relevant ADRs, the current implementation plan and applicable approved design. Identify historical/superseded statements explicitly.
- Validate links and referenced commands; update connected contract/usage documents when public behavior changes. Writing documentation alone does not authorize running the documented operation.
