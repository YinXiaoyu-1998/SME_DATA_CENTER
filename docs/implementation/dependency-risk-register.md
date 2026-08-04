# Dependency risk register

## Quality gate scope

Production JavaScript dependency advisories are enforced through
`npm audit --omit=dev` against the public npm registry. Runtime image advisories
are enforced with Trivy against the OS package layer only, using `--ignore-unfixed`
so the gate blocks actionable fixed-version vulnerabilities rather than Debian
tracker entries that cannot be patched by rebuilding or running `apt-get upgrade`.

## ExcelJS read-only XLSX exception

The `exceljs-read-only-xlsx-2026-07` exception is narrowly limited to the current
ExcelJS dependency chain and the two listed advisories. It applies to repository
production dependencies, the API image, and the release-operations image; it does
not apply to the worker image. It expires on 2027-01-31 and is owned by Enterprise
Hub maintainers.

The affected path imports authenticated XLSX uploads for structured-file use. The
import path enforces a 50 MiB decoded cap and ZIP entry, expansion, path, and
duplicate limits, plus sheet, row, and cell limits. This is not blanket acceptance
of ExcelJS or ZIP parsing: new advisories, packages, components, critical findings,
or a missed review deadline fail the policy.

Replacement is deferred while the protected import path remains stable and the
dependency graph is upgraded in a dedicated change. An upstream fix, a change to
the authenticated upload threat model, any related security incident, or new
ExcelJS/ZIP advisory triggers early review. `read-excel-file` is the leading
replacement candidate.

## Retained image moderate

| Vulnerability         | Package | Components                       | Impact                                                                                                                                                                                | Mitigation                                                                                                                                                | Owner                      | Review date |
| --------------------- | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------- |
| `GHSA-w5hq-g745-h8pq` | `uuid`  | `api-image`, `release-ops-image` | The affected UUID v3/v5/v6 buffer handling is installed only through the read-only ExcelJS dependency chain. Enterprise Hub does not call those APIs or provide their output buffers. | Keep XLSX ingestion authenticated and bounded, avoid the affected UUID APIs, and replace or upgrade the ExcelJS chain when a compatible fix is available. | Enterprise Hub maintainers | 2027-01-31  |

The worker image does not contain this dependency chain. Any additional moderate,
high, or critical image finding remains unaccepted until it receives its own exact
policy entry and risk review.
