"""Local PDF qualification adapter. Task 2/3 freeze the public DTO/service boundary."""

from __future__ import annotations

import hashlib
from difflib import SequenceMatcher
import importlib.metadata
import json
import math
import os
import unicodedata
from pathlib import Path

import pypdfium2 as pdfium

SERVICE_ROOT = Path(__file__).resolve().parents[2]
_PACKAGED_MANIFEST = Path(__file__).with_name("model-manifest.json")
MANIFEST_PATH = (
    _PACKAGED_MANIFEST
    if _PACKAGED_MANIFEST.is_file()
    else SERVICE_ROOT / "model-manifest.json"
)


class PdfParseError(ValueError):
    """Stable, body/path-free failure for the internal worker boundary."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text())


def _models(manifest: dict) -> Path:
    root = Path(os.environ.get("SMEDC_PDF_MODELS_PATH", SERVICE_ROOT / "models"))
    for model in manifest["files"]:
        path = root / model["path"]
        if not path.is_file():
            raise PdfParseError("PDF_MODEL_MISSING")
        if (
            path.stat().st_size != model["bytes"]
            or hashlib.sha256(path.read_bytes()).hexdigest() != model["sha256"]
        ):
            raise PdfParseError("PDF_MODEL_CHECKSUM_MISMATCH")
    for package, version in manifest["packages"].items():
        if importlib.metadata.version(package).split("+", 1)[0] != version:
            raise PdfParseError("PDF_RUNTIME_VERSION_MISMATCH")
    return root


def _bbox(box, page_size) -> dict:
    box = box.to_top_left_origin(page_size.height)
    return {
        "left": max(0.0, min(1.0, box.l / page_size.width)),
        "top": max(0.0, min(1.0, box.t / page_size.height)),
        "right": max(0.0, min(1.0, box.r / page_size.width)),
        "bottom": max(0.0, min(1.0, box.b / page_size.height)),
    }


def _overlap(a: dict, b: dict) -> bool:
    return min(a["right"], b["right"]) > max(a["left"], b["left"]) and min(
        a["bottom"], b["bottom"]
    ) > max(a["top"], b["top"])


def _compact(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).split())


def _converter(root: Path, manifest: dict):
    # Local model paths are mandatory and verified before importing ML libraries.
    # HF flags prevent implicit fallback downloads; container egress is closed in Task 3/6.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(manifest["parameters"]["cpuThreads"])
    from docling.datamodel.accelerator_options import (
        AcceleratorDevice,
        AcceleratorOptions,
    )
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        PdfPipelineOptions,
        RapidOcrOptions,
        TableFormerMode,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    from docling.models.stages.ocr.rapid_ocr_model import RapidOcrModel
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
    from docling_core.types.doc import BoundingBox, CoordOrigin

    class FullPageRapidOcrModel(RapidOcrModel):
        def get_ocr_rects(self, page):
            # Text exported as vector glyph outlines has no native cells or
            # bitmap rectangles. Render every page, but retain the native layer.
            return [
                BoundingBox(
                    l=0,
                    t=0,
                    r=page.size.width,
                    b=page.size.height,
                    coord_origin=CoordOrigin.TOPLEFT,
                )
            ]

        def _filter_ocr_cells(self, ocr_cells, programmatic_cells):
            kept = []
            for ocr in ocr_cells:
                box = _bbox(ocr.rect.to_bounding_box(), self._dedup_page_size)
                overlap = [
                    native
                    for native in programmatic_cells
                    if _overlap(
                        box, _bbox(native.rect.to_bounding_box(), self._dedup_page_size)
                    )
                ]
                if not any(
                    _compact(ocr.text) == _compact(native.text) for native in overlap
                ) and _compact(ocr.text) != _compact(
                    " ".join(native.text for native in overlap)
                ):
                    kept.append(ocr)
            return kept

        def post_process_cells(self, ocr_cells, page):
            # _filter_ocr_cells is invoked synchronously by the pinned base
            # implementation. Normalize against this page's physical geometry.
            self._dedup_page_size = page.size
            super().post_process_cells(ocr_cells, page)

    class FullPagePipeline(StandardPdfPipeline):
        def _make_ocr_model(self, art_path):
            return FullPageRapidOcrModel(
                enabled=True,
                artifacts_path=art_path,
                options=self.pipeline_options.ocr_options,
                accelerator_options=self.pipeline_options.accelerator_options,
            )

    opts = PdfPipelineOptions(
        artifacts_path=root,
        enable_remote_services=False,
        allow_external_plugins=False,
        do_ocr=True,
        do_table_structure=True,
        do_picture_description=False,
        do_picture_classification=False,
        do_code_enrichment=False,
        do_formula_enrichment=False,
        generate_parsed_pages=True,
        generate_page_images=False,
        generate_picture_images=False,
        ocr_batch_size=1,
        layout_batch_size=1,
        table_batch_size=1,
        queue_max_size=2,
        document_timeout=manifest["budgets"]["timeoutSeconds"],
        accelerator_options=AcceleratorOptions(
            device=AcceleratorDevice.CPU,
            num_threads=manifest["parameters"]["cpuThreads"],
        ),
        ocr_options=RapidOcrOptions(
            backend="onnxruntime",
            font_path=str(root / "fonts/NotoSansCJKsc-Regular.otf"),
            force_full_page_ocr=False,
            bitmap_area_threshold=0.0,
            text_score=manifest["parameters"]["ocrTextScore"],
            rapidocr_params=manifest["parameters"]["rapidocr"],
        ),
    )
    opts.table_structure_options.mode = TableFormerMode.ACCURATE
    opts.table_structure_options.do_cell_matching = True
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=opts, pipeline_cls=FullPagePipeline
            )
        },
    )


def _ruled_table(source, page_number, box, size, source_cells, reader, predicted):
    from smedc_pdf_parser.ruled_table import extract_vector_grid
    import numpy as np

    roi = (
        box["left"] * size.width,
        box["top"] * size.height,
        box["right"] * size.width,
        box["bottom"] * size.height,
    )
    with pdfium.PdfDocument(source) as pdf:
        page = pdf[page_number - 1]
        grid = extract_vector_grid(page, roi)
        if grid is None:
            return None
        cell_boxes = [
            {
                "left": cell_left / size.width,
                "top": t / size.height,
                "right": r / size.width,
                "bottom": b / size.height,
            }
            for cell_left, t, r, b in (cell["bboxPoints"] for cell in grid["cells"])
        ]
        text_page = page.get_textpage()
        native_chars = []
        for i in range(text_page.count_chars()):
            value = text_page.get_text_range(i, 1)
            if not value.strip():
                continue
            cell_left, b, r, t = text_page.get_charbox(i)
            native_chars.append(
                (
                    value,
                    {
                        "left": cell_left / size.width,
                        "top": (size.height - t) / size.height,
                        "right": r / size.width,
                        "bottom": (size.height - b) / size.height,
                    },
                )
            )

        def content_key(text):
            return "".join(
                c for c in _compact(text) if not unicodedata.category(c).startswith("P")
            )

        def represented_by_native(text, box):
            # Compare the actual native glyphs in THIS OCR rectangle, including
            # across a detector-joined row. Equal text elsewhere remains valid.
            overlap_text = "".join(
                value for value, cb in native_chars if _overlap(cb, box)
            )
            a, b = content_key(text), content_key(overlap_text)
            return bool(a and b) and (
                a in b or SequenceMatcher(None, a, b).ratio() >= 0.85
            )

        assigned = [[] for _ in cell_boxes]
        reocr = set()
        for text_cell, text_box in source_cells:
            if not text_cell.from_ocr or represented_by_native(
                text_cell.text, text_box
            ):
                continue
            area = (text_box["right"] - text_box["left"]) * (
                text_box["bottom"] - text_box["top"]
            )
            if area <= 0:
                continue
            targets = []
            for i, cb in enumerate(cell_boxes):
                overlap = max(
                    0,
                    min(cb["right"], text_box["right"])
                    - max(cb["left"], text_box["left"]),
                ) * max(
                    0,
                    min(cb["bottom"], text_box["bottom"])
                    - max(cb["top"], text_box["top"]),
                )
                if overlap / area > 0.18:
                    targets.append(i)
            if len(targets) > 1 and text_cell.from_ocr:
                # The detector can join adjacent step columns. Recognition on
                # individually ruled cells restores their independent meaning.
                reocr.update(targets)
            elif targets:
                cx = (text_box["left"] + text_box["right"]) / 2
                cy = (text_box["top"] + text_box["bottom"]) / 2
                for i in targets:
                    cb = cell_boxes[i]
                    if (
                        cb["left"] <= cx <= cb["right"]
                        and cb["top"] <= cy <= cb["bottom"]
                    ):
                        assigned[i].append((text_cell, text_box))
                        break
        image = page.render(scale=3).to_pil() if reocr else None
        headers = {
            _compact(c.text)
            for c in predicted.table_cells
            if c.column_header and c.text.strip()
        }
        header_rows = set()
        cells = []
        for i, cell in enumerate(grid["cells"]):
            ordered = sorted(
                assigned[i],
                key=lambda pair: (
                    round(pair[1]["top"] * size.height / 3),
                    pair[1]["left"],
                ),
            )
            cell_left, t, r, b = cell["bboxPoints"]
            native_text = unicodedata.normalize(
                "NFKC",
                text_page.get_text_bounded(
                    cell_left + 0.5,
                    size.height - b + 0.5,
                    r - 0.5,
                    size.height - t - 0.5,
                ),
            ).strip()
            extra_ocr = "\n".join(
                unicodedata.normalize("NFKC", c.text) for c, cb in ordered
            )
            text = "\n".join(part for part in (native_text, extra_ocr) if part)
            if i in reocr:
                cell_left, t, r, b = cell["bboxPoints"]
                crop = image.crop(
                    (
                        math.ceil((cell_left + 1) * 3),
                        math.ceil((t + 1) * 3),
                        math.floor((r - 1) * 3),
                        math.floor((b - 1) * 3),
                    )
                )
                ocr = reader(np.array(crop))
                extra = []
                for value, points in zip(
                    ocr.txts or (), ocr.boxes if ocr.boxes is not None else ()
                ):
                    ob = {
                        "left": (cell_left + 1 + min(p[0] for p in points) / 3)
                        / size.width,
                        "top": (t + 1 + min(p[1] for p in points) / 3) / size.height,
                        "right": (cell_left + 1 + max(p[0] for p in points) / 3)
                        / size.width,
                        "bottom": (t + 1 + max(p[1] for p in points) / 3) / size.height,
                    }
                    if not represented_by_native(value, ob):
                        extra.append(unicodedata.normalize("NFKC", value))
                text = "\n".join(
                    part for part in (native_text, "\n".join(extra)) if part
                )
            if _compact(text) in headers:
                header_rows.add(cell["row"])
            cells.append(
                {k: v for k, v in cell.items() if k != "bboxPoints"} | {"text": text}
            )
        text_page.close()
        return {
            "cells": cells,
            "rowCount": grid["rowCount"],
            "columnCount": grid["columnCount"],
            "headerRows": sorted(header_rows),
        }


def convert_pdf(source: Path) -> dict:
    """Convert a local, already-owned PDF using verified offline model artifacts.

    No URLs, image descriptions, credentials or runtime model downloads. Concurrent
    calls and hard timeout/memory termination are owned by the Task 3 service.
    """
    manifest = _manifest()
    budgets = manifest["budgets"]
    if source.stat().st_size > budgets["inputBytes"]:
        raise PdfParseError("PDF_INPUT_TOO_LARGE")
    try:
        pdf = pdfium.PdfDocument(source)
    except pdfium.PdfiumError as error:
        raise PdfParseError("PDF_INVALID_OR_ENCRYPTED") from error
    try:
        count = len(pdf)
        if not 0 < count <= budgets["pages"]:
            raise PdfParseError("PDF_PAGE_LIMIT")
        total_pixels = 0
        for page in pdf:
            width, height = page.get_size()
            pixels = math.ceil(width * 3) * math.ceil(height * 3)
            if not math.isfinite(width * height) or pixels > budgets["pagePixels"]:
                raise PdfParseError("PDF_PIXEL_LIMIT")
            total_pixels += pixels
            page.close()
        if total_pixels > budgets["totalPixels"]:
            raise PdfParseError("PDF_PIXEL_LIMIT")
    finally:
        pdf.close()

    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    root = _models(manifest)
    converter = _converter(root, manifest)
    conversion = converter.convert(
        source,
        raises_on_error=False,
        max_num_pages=budgets["pages"],
        max_file_size=budgets["inputBytes"],
    )
    from docling.datamodel.base_models import ConversionStatus

    if conversion.status != ConversionStatus.SUCCESS or len(conversion.pages) != count:
        raise PdfParseError("PDF_INCOMPLETE_PARSE")
    document = conversion.document
    reader = next(iter(converter.initialized_pipelines.values())).ocr_model.reader
    blocks, tables, pictures = [], [], []
    ruled_regions = []
    headings = []
    cells_by_page = {}
    for page in conversion.pages:
        cells_by_page[page.page_no] = [
            (cell, _bbox(cell.rect.to_bounding_box(), page.size))
            for cell in page.cells
            if cell.text.strip()
        ]

    def identifier(kind, page, ordinal):
        return f"{kind}-{checksum[:20]}-p{page}-{ordinal}"

    def location(page_number, box, text):
        related = [
            cell
            for cell, cell_box in cells_by_page.get(page_number, [])
            if _overlap(box, cell_box) and _compact(cell.text) in _compact(text)
        ]
        return {
            "pageNumber": page_number,
            "bbox": box,
            "method": "ocr" if any(cell.from_ocr for cell in related) else "native",
            "blockOrdinal": len(blocks) + 1,
        }

    for item, _level in document.iterate_items():
        if not item.prov:
            continue
        prov = item.prov[0]
        page_number = prov.page_no
        box = _bbox(prov.bbox, document.pages[page_number].size)
        label = item.label.value
        if label == "picture":
            pictures.append(
                {
                    "id": identifier("picture", page_number, len(pictures)),
                    "pageNumber": page_number,
                    "bbox": box,
                    "caption": item.caption_text(document) or None,
                    "ocrBlockIds": [],
                }
            )
            continue
        table_id = None
        if label == "table":
            data = item.data
            table_id = identifier("table", page_number, len(tables))
            table_cells = [
                {
                    "row": c.start_row_offset_idx,
                    "column": c.start_col_offset_idx,
                    "rowSpan": c.row_span,
                    "columnSpan": c.col_span,
                    "text": unicodedata.normalize("NFKC", c.text),
                }
                for c in data.table_cells
            ]
            table_cells.sort(key=lambda c: (c["row"], c["column"]))
            structured = _ruled_table(
                source,
                page_number,
                box,
                document.pages[page_number].size,
                cells_by_page[page_number],
                reader,
                data,
            )
            if structured:
                ruled_regions.append((page_number, box))
            table = structured or {
                "cells": table_cells,
                "headerRows": sorted(
                    {
                        c.start_row_offset_idx
                        for c in data.table_cells
                        if c.column_header
                    }
                ),
                "rowCount": data.num_rows,
                "columnCount": data.num_cols,
            }
            tables.append({"id": table_id, **table})
            text = "\n".join(
                " | ".join(c["text"] for c in table["cells"] if c["row"] == row)
                for row in range(table["rowCount"])
            )
            kind = "table"
        else:
            text = unicodedata.normalize("NFKC", getattr(item, "text", ""))
            kind = (
                "heading"
                if label in ("section_header", "title")
                else "list"
                if label == "list_item"
                else "paragraph"
            )
        if not text.strip():
            continue
        if kind == "heading":
            headings = [text]
        metadata = (
            {"tableId": table_id, "rowStart": 0, "rowEnd": tables[-1]["rowCount"] - 1}
            if table_id
            else {}
        )
        blocks.append(
            {
                "blockId": identifier("block", page_number, len(blocks)),
                "blockType": kind,
                "text": text,
                "headingPath": list(headings),
                "sourceLocation": location(page_number, box, text),
                "metadata": metadata,
            }
        )

    # Layout "picture" clusters may contain valuable OCR. Retain cells omitted by
    # the assembled document, comparing BOTH content and position (never global dedup).
    for page_number, cells in cells_by_page.items():
        for cell, box in cells:
            cx, cy = (box["left"] + box["right"]) / 2, (box["top"] + box["bottom"]) / 2
            if any(
                p == page_number
                and region["left"] <= cx <= region["right"]
                and region["top"] <= cy <= region["bottom"]
                for p, region in ruled_regions
            ):
                continue  # Every source cell is assigned or cropped/re-recognized by a complete native grid.
            if any(
                b["sourceLocation"]["pageNumber"] == page_number
                and _overlap(b["sourceLocation"]["bbox"], box)
                and _compact(cell.text) in _compact(b["text"])
                for b in blocks
            ):
                continue
            block = {
                "blockId": identifier("block", page_number, len(blocks)),
                "blockType": "paragraph",
                "text": unicodedata.normalize("NFKC", cell.text),
                "headingPath": [],
                "sourceLocation": {
                    "pageNumber": page_number,
                    "bbox": box,
                    "method": "ocr" if cell.from_ocr else "native",
                    "blockOrdinal": len(blocks) + 1,
                },
                "metadata": {},
            }
            blocks.append(block)
    for picture in pictures:
        picture["ocrBlockIds"] = [
            b["blockId"]
            for b in blocks
            if b["sourceLocation"]["pageNumber"] == picture["pageNumber"]
            and b["sourceLocation"]["method"] == "ocr"
            and _overlap(b["sourceLocation"]["bbox"], picture["bbox"])
        ]
    blocks.sort(
        key=lambda b: (
            b["sourceLocation"]["pageNumber"],
            b["sourceLocation"]["bbox"]["top"],
            b["sourceLocation"]["bbox"]["left"],
        )
    )
    pages = []
    for page in conversion.pages:
        has_text = any(
            b["sourceLocation"]["pageNumber"] == page.page_no for b in blocks
        )
        has_image = any(p["pageNumber"] == page.page_no for p in pictures)
        pages.append(
            {
                "pageNumber": page.page_no,
                "outcome": "parsed"
                if has_text
                else "image_only"
                if has_image
                else "blank",
            }
        )
    result = {
        "schemaVersion": 1,
        "sourceChecksumSha256": checksum,
        "parserFingerprint": hashlib.sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "pageCount": count,
        "pages": pages,
        "blocks": blocks,
        "tables": tables,
        "pictures": pictures,
        "warnings": [],
    }
    if len(json.dumps(result, ensure_ascii=False).encode()) > budgets["outputBytes"]:
        raise PdfParseError("PDF_OUTPUT_TOO_LARGE")
    return result
