# Synthetic ledger PDF conversion fixture

`snapshot.ts` generates invented Chinese rows, exact decimal strings, a long address,
leading-zero and plus-prefixed phone numbers, and null fields. The conversion check
creates two red/blue synthetic certificate images. No customer data or credentials
are used. Temporary XLSX files never leave the render scratch directory.

Default unit tests need no LibreOffice installation:

```sh
npx vitest run apps/worker/src/ledger-pdf/renderer.test.ts
```

The worker image contains Calc, Noto CJK, `pdfinfo`, `pdftotext`, `pdftoppm`, and a
compiled synthetic check entry. Build and run the same controlled image:

```sh
docker build --target worker -t smedc-ledger-renderer:local .
docker run --rm -e LEDGER_PDF_RENDER_INTEGRATION=1 \
  smedc-ledger-renderer:local node dist/release/ledger-pdf-render-check.js
```

The check verifies all 11 repeated headers, every row, exact phones and decimals,
complete wrapped Chinese address, blank nulls, two receipt-labelled attachment pages,
and substantial red/blue image content in Poppler rasterizations. It deletes scratch
files by default. For human visual review, bind-mount an empty writable directory to
`/output` and set `LEDGER_PDF_OUTPUT_DIRECTORY=/output`; the PDF, synthetic images,
and page PNGs are then retained for inspection and should be removed afterward.

When these same tools are available locally, the gated Vitest integration is:

```sh
LEDGER_PDF_RENDER_INTEGRATION=1 npx vitest run apps/worker/src/ledger-pdf/renderer.integration.test.ts
```

Renderer input limits are 10,000 rows, 200 photos, 500 MiB of photo input and
200 MiB of PDF output. Images are read sequentially with an aggregate byte bound;
normalization rejects images above 40 million pixels and caps aggregate normalized
image bytes at 500 MiB. EXIF orientation is applied, image resolution is reduced to
fit within 2048×2048 pixels without cropping, and placement preserves aspect ratio.
Long fields, including valid 512-character Chinese values, use continuation rows rather
than losing text. Calc gets
an isolated user profile and a 180-second timeout; cancellation and timeout kill its
complete process group. Successful PDF paths remain until the caller removes them
following upload; profiles and intermediate files are always removed.

Audit the production tree with `npm run audit:production` and scan the worker image
with the repository's Trivy policy. No ExcelJS read-only risk exception applies to
this renderer. Renderer dependencies must pass without exemptions; unrelated
baseline findings still block release and must be reported separately.
