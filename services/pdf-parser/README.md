# Local PDF parser

`convert_pdf(Path) -> dict` is the qualified local adapter; Tasks 2/3 freeze the public DTO and service boundary. It uses the standard Docling pipeline, Chinese PP-OCRv4 through RapidOCR/ONNX Runtime, and accurate TableFormer. It renders every page for OCR while preserving native text, including PDFs whose visible letters are vector outlines. It never generates image descriptions.

Use Python 3.12 and `uv sync --locked --project services/pdf-parser`. Linux Torch and TorchVision resolve exclusively from the official CPU wheel index; the lock excludes CUDA/NVIDIA/Triton dependencies. macOS uses its platform wheels with explicit CPU execution. Runtime does not install dependencies or download models.

Before starting the offline runtime, deposit each `model-manifest.json` file at its exact relative path below `SMEDC_PDF_MODELS_PATH` (default: this service's ignored `models/`). The manifest records public source revisions, download URLs, byte lengths, SHA-256 values and licenses. Deployment preparation must verify these artifacts and retain upstream license notices. The adapter verifies all selected files and library versions before initializing models; missing or changed artifacts fail closed. Weights are deliberately absent from source distributions and wheels.

Run the focused synthetic regression suite with:

```sh
uv run --locked --project services/pdf-parser pytest services/pdf-parser/tests/test_convert.py
```

The tests use actual native, raster and vector-outline PDFs and deny socket connections. They cover table cell pairs, physical pages, mixed-page OCR, valid repeated rows, mixed content in one ruled cell, model failures, malformed PDFs, oversized rendering and page limits. They require the prepared model directory.

For complete native straight-line grids, cell boundaries come from the original PDF. Missing boundaries permit only rectangular merged cells; incomplete outer boundaries, irregular grids, raster grids and unruled tables fall back to the same accurate TableFormer result. OCR that crosses multiple ruled cells is recognized again from individual cell crops. Native glyph bounds and normalized text comparisons remove overlapping duplicate OCR while retaining separate bitmap/outline text. There is no document-wide text deduplication.

The manifest declares finite input, page, rendering, output, time, memory and concurrency budgets. The adapter enforces input/pages/render/output and configures the Docling timeout. Task 3 must enforce cancellation, a hard wall-clock deadline, process memory and concurrency, authenticate the HTTP boundary, and deny container egress. The 8 GiB parser budget and 12 GiB host recommendation are initial budgets based on local macOS representative measurements, not Linux deployment qualification. Task 3/6 must measure the Linux CPU container; `RLIMIT_AS` limits virtual address space rather than measured RSS and cannot be inferred from those measurements.

The manifest fingerprint identifies selected artifacts and parameters. Bump `adapterVersion` when changing parsing behavior after this initial qualification. Private real-sample questions, source hashes, corrections, parser outputs and measurements remain outside the tracked service.
