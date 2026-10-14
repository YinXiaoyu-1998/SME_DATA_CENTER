# Minimal administrator UI

- Match login/password i18n: `zh-CN` default, `en` switching, preserve explicit valid preference; localize fields, validation, conflicts, confirmations and expiry states. Keep business names unchanged.

- Read `docs/implementation/admin-permissions-ui-design.md` for interaction/security contracts and `apps/api/AGENTS.md` for onboarding/administration boundaries.
- Use names for display and persistent IDs for binding. Preserve complete grant combinations and existing grants not displayed by the current UI.
- Submit each save with the current expected version. On conflicts, retain the in-memory draft and require reload/comparison/reconfirmation; do not silently overwrite, merge or blindly retry.
- Keep drafts out of persistent browser storage and prevent submission after logout/expiry. Preparation is read-only; show specific missing inputs rather than inventing permissions or resource attributes.
- Preserve the lightweight page/client architecture. Focused checks: `npm test -- apps/admin-web/src`; include API browser-route tests for page/server changes.
