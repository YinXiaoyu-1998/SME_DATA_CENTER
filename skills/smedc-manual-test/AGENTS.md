# Official manual acceptance

Applies to running the full official workflow, including invocations from the repository root.

- Run the full official workflow only when explicitly requested. First read `skills/smedc-manual-test/SKILL.md` and `docs/implementation/official-manual-acceptance.md`.
- Use official staging, macOS Codex, browser auth, and the launcher version specified by the acceptance document. Use fresh synthetic accounts; the agent must not open setup links or type test credentials. The human may disclose that synthetic password in the current private chat and must complete setup one at a time; never persist credentials.
- Employee-client steps must use the official launcher/MCP path. Controller access is for setup, verification, and cleanup only.
- Run `npm run test:official-manual`; delete all run-scoped DB/storage/Qdrant data and synthetic accounts before reporting success.
