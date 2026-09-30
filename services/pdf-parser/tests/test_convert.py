"""Real, synthetic PDFs: catches dropped OCR and misplaced table values."""

from io import BytesIO
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))


def scan_table():
    pdf = BytesIO()
    c = canvas.Canvas(pdf, pagesize=(500, 230))
    c.setFont("STSong-Light", 19)
    for y in (40, 90, 140, 190):
        c.line(20, y, 480, y)
    for x in (20, 240, 350, 480):
        c.line(x, 40, x, 190)
    for y, row in zip(
        (158, 108, 58),
        (("食材", "单位", "数量"), ("黄瓜", "克", "60"), ("小米辣", "克", "5")),
    ):
        for x, text in zip((35, 260, 375), row):
            c.drawString(x, y, text)
    c.save()
    document = pdfium.PdfDocument(pdf.getvalue())
    return document[0].render(scale=3).to_pil()


def create_pdf(path, mixed=False):
    c = canvas.Canvas(str(path), pagesize=(595, 842))
    c.showPage()  # blank first page proves physical page numbering
    if mixed:
        c.setFont("STSong-Light", 22)
        c.drawString(40, 760, "原生正文仅出现一次")
    c.drawImage(ImageReader(scan_table()), 40, 400, width=500, height=230)
    c.save()
    return path


def convert(path):
    try:
        from smedc_pdf_parser.convert import convert_pdf
    except ModuleNotFoundError:
        pytest.fail("convert_pdf has not been implemented")
    return convert_pdf(path)


def compact(text):
    return "".join(text.split())


def table_rows(result):
    return [
        [compact(c["text"]) for c in table["cells"] if c["row"] == row]
        for table in result["tables"]
        for row in range(table["rowCount"])
    ]


def test_image_table_preserves_cell_pairs(tmp_path):
    result = convert(create_pdf(tmp_path / "scan.pdf"))
    rows = table_rows(result)
    assert ["黄瓜", "克", "60"] in rows
    assert ["小米辣", "克", "5"] in rows
    assert result["pageCount"] == 2
    assert result["pages"][0]["outcome"] == "blank"
    assert result["pages"][1]["outcome"] == "parsed"
    assert any(
        b["sourceLocation"]["pageNumber"] == 2
        and b["sourceLocation"]["method"] == "ocr"
        for b in result["blocks"]
    )


def test_mixed_page_keeps_image_text_without_duplicate_native_text(tmp_path):
    result = convert(create_pdf(tmp_path / "mixed.pdf", mixed=True))
    body = compact("\n".join(b["text"] for b in result["blocks"]))
    assert body.count("原生正文仅出现一次") == 1
    assert "黄瓜" in body and "小米辣" in body
    assert ["黄瓜", "克", "60"] in table_rows(result)
    native = [b for b in result["blocks"] if "原生正文" in compact(b["text"])]
    assert native[0]["sourceLocation"]["pageNumber"] == 2
    assert native[0]["sourceLocation"]["method"] == "native"


def test_vector_outline_text_is_ocr_even_with_partial_bitmap_page(tmp_path):
    # PDF has neither native text nor a bitmap in the title area. Skipping OCR
    # outside embedded photos silently drops this common exported-slide format.
    from fontTools.pens.basePen import BasePen
    from fontTools.ttLib import TTFont
    import reportlab

    font = TTFont(Path(reportlab.__file__).parent / "fonts" / "Vera.ttf")
    glyphs = font.getGlyphSet()
    path = tmp_path / "outline.pdf"
    c = canvas.Canvas(str(path), pagesize=(595, 842))

    class CanvasPen(BasePen):
        def _moveTo(self, p):
            self.path.moveTo(*p)

        def _lineTo(self, p):
            self.path.lineTo(*p)

        def _curveToOne(self, p1, p2, p3):
            self.path.curveTo(*p1, *p2, *p3)

        def _closePath(self):
            self.path.close()

        def _endPath(self):
            pass

    c.saveState()
    c.translate(40, 750)
    c.scale(30 / font["head"].unitsPerEm, 30 / font["head"].unitsPerEm)
    for char in "VECTOR 42":
        glyph = glyphs[font.getBestCmap()[ord(char)]]
        pen = CanvasPen(glyphs)
        pen.path = c.beginPath()
        glyph.draw(pen)
        c.drawPath(pen.path, fill=1, stroke=0)
        c.translate(glyph.width, 0)
    c.restoreState()
    c.drawImage(ImageReader(scan_table()), 40, 400, width=500, height=230)
    c.save()
    result = convert(path)
    matches = [b for b in result["blocks"] if "VECTOR42" in compact(b["text"])]
    assert len(matches) == 1
    assert matches[0]["sourceLocation"]["method"] == "ocr"


@pytest.fixture(autouse=True)
def offline_runtime(monkeypatch):
    import socket

    def reject(*args, **kwargs):
        pytest.fail("PDF conversion must not open a network connection")

    monkeypatch.setattr(socket.socket, "connect", reject)
    monkeypatch.setattr(socket, "create_connection", reject)


def test_missing_models_fail_closed(tmp_path, monkeypatch):
    from smedc_pdf_parser.convert import PdfParseError

    monkeypatch.setenv("SMEDC_PDF_MODELS_PATH", str(tmp_path / "missing"))
    with pytest.raises(PdfParseError, match="^PDF_MODEL_MISSING$"):
        convert(create_pdf(tmp_path / "scan.pdf"))


def test_bad_model_checksum_fails_before_loading(tmp_path, monkeypatch):
    import json
    from smedc_pdf_parser.convert import MANIFEST_PATH, PdfParseError

    manifest = json.loads(MANIFEST_PATH.read_text())
    model_root = tmp_path / "models"
    artifact = model_root / manifest["files"][0]["path"]
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"not a model")
    monkeypatch.setenv("SMEDC_PDF_MODELS_PATH", str(model_root))
    with pytest.raises(PdfParseError, match="^PDF_MODEL_CHECKSUM_MISMATCH$"):
        convert(create_pdf(tmp_path / "scan.pdf"))


def test_oversized_page_rejected_before_rendering(tmp_path):
    from smedc_pdf_parser.convert import PdfParseError

    source = tmp_path / "giant.pdf"
    c = canvas.Canvas(str(source), pagesize=(10000, 10000))
    c.rect(0, 0, 5000, 5000, fill=1)
    c.save()
    with pytest.raises(PdfParseError, match="^PDF_PIXEL_LIMIT$"):
        convert(source)


def test_201_pages_rejected_before_model_loading(tmp_path):
    from smedc_pdf_parser.convert import PdfParseError

    source = tmp_path / "long.pdf"
    c = canvas.Canvas(str(source))
    for _ in range(201):
        c.showPage()
    c.save()
    with pytest.raises(PdfParseError, match="^PDF_PAGE_LIMIT$"):
        convert(source)


def test_corrupt_pdf_has_stable_failure(tmp_path):
    from smedc_pdf_parser.convert import PdfParseError

    source = tmp_path / "corrupt.pdf"
    source.write_bytes(b"%PDF-corrupted")
    with pytest.raises(PdfParseError, match="^PDF_INVALID_OR_ENCRYPTED$"):
        convert(source)


def test_vector_grid_preserves_merged_header_and_three_step_columns(tmp_path):
    path = tmp_path / "merged.pdf"
    c = canvas.Canvas(str(path), pagesize=(600, 400))
    for y in (50, 130, 210, 280):
        c.line(30, y, 570, y)
    for x in (30, 570):
        c.line(x, 50, x, 280)
    for x in (210, 390):
        c.line(x, 50, x, 210)  # merged top header, three independent steps
    c.save()
    try:
        from smedc_pdf_parser.ruled_table import extract_vector_grid
    except ModuleNotFoundError:
        pytest.fail("vector grid reconstruction has not been implemented")
    with pdfium.PdfDocument(path) as pdf:
        grid = extract_vector_grid(pdf[0], (29, 119, 571, 351))
    assert grid is not None
    assert grid["rowCount"] == 3 and grid["columnCount"] == 3
    assert [
        (cell["row"], cell["column"], cell["rowSpan"], cell["columnSpan"])
        for cell in grid["cells"]
    ] == [
        (0, 0, 1, 3),
        (1, 0, 1, 1),
        (1, 1, 1, 1),
        (1, 2, 1, 1),
        (2, 0, 1, 1),
        (2, 1, 1, 1),
        (2, 2, 1, 1),
    ]


def test_equal_text_in_different_rows_is_not_deduplicated(tmp_path):
    path = tmp_path / "repeated.pdf"
    c = canvas.Canvas(str(path), pagesize=(500, 350))
    c.setFont("STSong-Light", 22)
    for y in (70, 130, 190, 250):
        c.line(30, y, 470, y)
    for x in (30, 320, 470):
        c.line(x, 70, x, 250)
    for y, label, amount in (
        (210, "事项", "金额"),
        (150, "重复项目", "10"),
        (90, "重复项目", "20"),
    ):
        c.drawString(50, y, label)
        c.drawString(340, y, amount)
    c.save()
    result = convert(path)
    rows = table_rows(result)
    assert ["重复项目", "10"] in rows
    assert ["重复项目", "20"] in rows
    assert (
        compact("\n".join(b["text"] for b in result["blocks"])).count("重复项目") == 2
    )


def test_graphic_only_page_keeps_source_region(tmp_path):
    path = tmp_path / "graphic.pdf"
    c = canvas.Canvas(str(path), pagesize=(500, 500))
    c.setFillColorRGB(0.2, 0.4, 0.7)
    c.circle(250, 250, 80, fill=1, stroke=0)
    c.save()
    result = convert(path)
    assert result["pages"] == [{"pageNumber": 1, "outcome": "image_only"}]
    assert any(picture["pageNumber"] == 1 for picture in result["pictures"])


def test_ruled_cell_preserves_native_and_separate_bitmap_text(tmp_path):
    raster = BytesIO()
    c = canvas.Canvas(raster, pagesize=(240, 45))
    c.setFont("Helvetica", 24)
    c.drawString(5, 10, "RASTER 76")
    c.save()
    bitmap_pdf = pdfium.PdfDocument(raster.getvalue())
    bitmap = bitmap_pdf[0].render(scale=3).to_pil()
    source = tmp_path / "cell-mixed.pdf"
    c = canvas.Canvas(str(source), pagesize=(600, 400))
    for y in (50, 110, 250, 300):
        c.line(30, y, 570, y)
    for x in (30, 340, 570):
        c.line(x, 50, x, 300)
    c.setFont("Helvetica", 20)
    c.drawString(40, 270, "Description")
    c.drawString(350, 270, "Amount")
    c.drawString(40, 220, "Visible native text")
    c.drawImage(ImageReader(bitmap), 40, 140, width=240, height=45)
    c.drawString(350, 180, "10")
    c.drawString(40, 70, "Final row")
    c.drawString(350, 70, "20")
    c.save()
    result = convert(source)
    cells = [cell["text"] for table in result["tables"] for cell in table["cells"]]
    assert any(
        "Visiblenativetext" in compact(text) and "RASTER76" in compact(text)
        for text in cells
    )


def test_upright_table_with_rotated_page_keeps_rows_columns_and_header(tmp_path):
    data = BytesIO()
    c = canvas.Canvas(data, pagesize=(600, 400))
    c.translate(600, 400)
    c.rotate(180)  # inverse content transform: /Rotate makes it visibly upright
    for y in (50, 150, 250, 350):
        c.line(30, y, 570, y)
    for x in (30, 300, 570):
        c.line(x, 50, x, 350)
    c.setFont("Helvetica", 20)
    for y, row in (
        (310, ("Description", "Amount")),
        (210, ("Apples", "10")),
        (110, ("Pears", "20")),
    ):
        for x, text in zip((50, 320), row):
            c.drawString(x, y, text)
    c.save()
    source = tmp_path / "rotated.pdf"
    with pdfium.PdfDocument(data.getvalue()) as pdf:
        page = pdf[0]
        page.set_rotation(180)
        pdf.save(source)
        page.close()
    result = convert(source)
    assert table_rows(result) == [
        ["Description", "Amount"],
        ["Apples", "10"],
        ["Pears", "20"],
    ]
    assert result["tables"][0]["headerRows"] == [0]


def test_intermediate_render_pixel_limit_rejects_before_model_loading(
    tmp_path, monkeypatch
):
    from smedc_pdf_parser import convert as adapter

    source = tmp_path / "intermediate-limit.pdf"
    c = canvas.Canvas(str(source), pagesize=(1000, 1000))
    c.drawString(30, 30, "pixel probe")
    c.save()

    def unexpected_model_loading(*args):
        pytest.fail("pixel preflight must reject before model loading")

    monkeypatch.setattr(adapter, "_models", unexpected_model_loading)
    with pytest.raises(adapter.PdfParseError, match="^PDF_PIXEL_LIMIT$"):
        convert(source)


def test_invalid_structured_table_is_rejected_before_row_expansion(
    tmp_path, monkeypatch
):
    from smedc_pdf_parser import convert as adapter

    monkeypatch.setattr(
        adapter,
        "_ruled_table",
        lambda *args, **kwargs: dict(
            rowCount=1025,
            columnCount=1,
            headerRows=[],
            cells=[dict(row=0, column=0, rowSpan=1, columnSpan=1, text="invalid")],
        ),
    )
    with pytest.raises(ValueError, match="^PDF_INVALID_RESULT$"):
        convert(create_pdf(tmp_path / "schema-table.pdf"))


def test_password_protected_pdf_has_stable_failure(tmp_path):
    from smedc_pdf_parser.convert import PdfParseError

    source = tmp_path / "protected.pdf"
    c = canvas.Canvas(str(source), encrypt="synthetic-pdf-password")
    c.drawString(20, 20, "Synthetic protected document")
    c.save()
    with pytest.raises(PdfParseError, match="^PDF_INVALID_OR_ENCRYPTED$"):
        convert(source)


def partial_grid_pdf(path, region):
    c = canvas.Canvas(str(path), pagesize=(400, 300))
    left, top, right, bottom = region
    for y in (top, (top + bottom) / 2, bottom):
        c.line(left, 300 - y, right, 300 - y)
    for x in (left, (left + right) / 2, right):
        c.line(x, 300 - top, x, 300 - bottom)
    c.save()
    return path


@pytest.mark.parametrize("region", [(30, 40, 370, 140), (30, 140, 370, 240), (30, 40, 200, 240)])
def test_vector_subsection_cannot_replace_full_predicted_table(tmp_path, region):
    from smedc_pdf_parser.ruled_table import extract_vector_grid
    with pdfium.PdfDocument(partial_grid_pdf(tmp_path / "partial.pdf", region)) as pdf:
        assert extract_vector_grid(pdf[0], (30, 40, 370, 240)) is None


def test_vector_grid_accepts_empty_prediction_margins_but_not_omitted_native_text(tmp_path):
    from smedc_pdf_parser.ruled_table import extract_vector_grid
    source = partial_grid_pdf(tmp_path / "margins.pdf", (30, 40, 370, 240))
    with pdfium.PdfDocument(source) as pdf:
        assert extract_vector_grid(pdf[0], (28, 38, 372, 242)) is not None
    c = canvas.Canvas(str(source), pagesize=(400, 300))
    for y in (60, 160, 260):
        c.line(30, y, 370, y)
    for x in (30, 200, 370):
        c.line(x, 60, x, 260)
    c.setFont("Helvetica", 1)
    c.drawString(30.1, 261.2, "omitted")  # inside the prediction margin, outside the grid
    c.save()
    with pdfium.PdfDocument(source) as pdf:
        assert extract_vector_grid(pdf[0], (28, 38, 372, 242)) is None


def test_converter_retains_predicted_rows_when_vector_grid_is_partial(tmp_path, monkeypatch):
    from types import SimpleNamespace as NS
    from docling.datamodel.base_models import ConversionStatus
    from docling_core.types.doc import BoundingBox, CoordOrigin, Size
    from smedc_pdf_parser import convert as adapter

    source = partial_grid_pdf(tmp_path / "partial-conversion.pdf", (30, 140, 370, 240))
    size = Size(width=400, height=300)
    data = NS(num_rows=4, num_cols=2, table_cells=[
        NS(start_row_offset_idx=r, start_col_offset_idx=c, row_span=1, col_span=1,
           text=f"row{r}col{c}", column_header=r == 0)
        for r in range(4) for c in range(2)
    ])
    item = NS(label=NS(value="table"), data=data, prov=[NS(page_no=1, bbox=BoundingBox(l=30, t=40, r=370, b=240, coord_origin=CoordOrigin.TOPLEFT))])
    document = NS(pages={1: NS(size=size)}, iterate_items=lambda: [(item, 0)])
    conversion = NS(status=ConversionStatus.SUCCESS, pages=[NS(page_no=1, size=size, cells=[])], document=document)
    converter = NS(convert=lambda *args, **kwargs: conversion, initialized_pipelines={0: NS(ocr_model=NS(reader=None))})
    monkeypatch.setattr(adapter, "_models", lambda _: tmp_path)
    monkeypatch.setattr(adapter, "_converter", lambda *args: converter)
    result = convert(source)
    assert result["tables"][0]["rowCount"] == 4
    assert len(result["tables"][0]["cells"]) == 8
    assert "row0col0" in result["blocks"][0]["text"]
    assert "row3col1" in result["blocks"][0]["text"]


def test_ruled_converter_rejects_ocr_content_outside_native_grid(tmp_path):
    from types import SimpleNamespace as NS
    from smedc_pdf_parser.convert import _ruled_table
    source = partial_grid_pdf(tmp_path / "ocr-margin.pdf", (30, 40, 370, 240))
    box = dict(left=28/400, top=38/300, right=372/400, bottom=242/300)
    cell = (NS(text="omitted OCR", from_ocr=True), dict(left=28/400, right=29/400, top=50/300, bottom=60/300))
    assert _ruled_table(source, 1, box, NS(width=400, height=300), [cell], None, None) is None
