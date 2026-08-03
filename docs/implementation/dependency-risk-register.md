# Dependency risk register

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
