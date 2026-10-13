# Shared domain rules

- Keep this package independent of HTTP, Prisma and storage runtimes. Shared registries, validation, limits and policy functions belong here; consumers should not fork definitions.
- Permission work reads `docs/implementation/business-related-authorization-design.md` and `docs/implementation/business-authorization-cutover.md`. `CONTEXT.md` is the current glossary; ADRs are historical decision records. Verify the applicable authorization mode and consult current contracts rather than restoring superseded policy.
- Preserve `canReadResource` semantics: disabled/cross-org/not-enabled/invalid/incomplete resources fail closed; clearance and business grants are independent requirements. Admin configuration authority is not blanket ordinary-read authority.
- Every resource scope must match a complete grant; never combine partial conditions across grants. Preserve exact store identity, explicit group ownership, required dimensions and dynamic-all versus fixed selections.
- Fixed categories use configured category levels; evidence uses its explicit file level. Never infer missing attributes from names, roles or content.
- Keep structured field/operator/type registries and retrieval version/config contracts aligned with consumers. Public receipt keys remain `receiptId` / `receipt_id`, distinct from source document IDs.
- Focused checks: `npm test -- packages/domain/src`. Policy changes also need SQL/compiler parity checks in `packages/db` and the affected public path.
