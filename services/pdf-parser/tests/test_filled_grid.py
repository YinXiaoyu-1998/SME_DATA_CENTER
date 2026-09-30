"""Recover invalid model spans only from a complete native rectangular tiling."""

from types import SimpleNamespace

import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen import canvas


def filled_table(path, *, overlap=False, margin_text=False):
    c = canvas.Canvas(str(path), pagesize=(400, 300))
    cells = [
        (30, 210, 170, 50, "Group"),
        (200, 210, 170, 50, "Detail"),
        (30, 110, 170, 100, "Upper merged"),
        (200, 160, 170, 50, "Row A"),
        (200, 110, 170, 50, "Row B"),
        (30, 60, 170, 50, "Lower separate"),
        (200, 60, 170, 50, "Row C"),
    ]
    if overlap:
        cells.append((30, 60, 170, 100, "Invalid overlap"))
    for i, (x, y, width, height, text) in enumerate(cells):
        c.setFillColorRGB(0.2, 0.4 + i * 0.03, 0.3)
        c.rect(x, y, width, height, fill=1, stroke=0)
        c.setFillColorRGB(0, 0, 0)
        c.setFont("Helvetica", 14)
        c.drawString(x + 8, y + 20, text)
    if margin_text:
        c.setFont("Helvetica", 1)
        c.drawString(28, 200, "X")
    c.save()
    return path


def extract(page):
    from smedc_pdf_parser import ruled_table

    if not hasattr(ruled_table, "extract_filled_grid"):
        pytest.fail("Native filled-rectangle tiling recovery is missing")
    return ruled_table.extract_filled_grid(page, (29, 39, 371, 241))


def test_filled_rectangles_preserve_adjacent_distinct_merged_regions(tmp_path):
    with pdfium.PdfDocument(filled_table(tmp_path / "filled.pdf")) as pdf:
        grid = extract(pdf[0])
    assert grid is not None
    assert (grid["rowCount"], grid["columnCount"]) == (4, 2)
    assert [
        (c["row"], c["column"], c["rowSpan"], c["columnSpan"]) for c in grid["cells"]
    ] == [
        (0, 0, 1, 1),
        (0, 1, 1, 1),
        (1, 0, 2, 1),
        (1, 1, 1, 1),
        (2, 1, 1, 1),
        (3, 0, 1, 1),
        (3, 1, 1, 1),
    ]


def test_overlapping_fills_cannot_be_used_as_table_geometry(tmp_path):
    with pdfium.PdfDocument(
        filled_table(tmp_path / "overlap.pdf", overlap=True)
    ) as pdf:
        assert extract(pdf[0]) is None


def test_rotated_filled_grid_is_not_used(tmp_path):
    with pdfium.PdfDocument(filled_table(tmp_path / "rotation.pdf")) as pdf:
        page = pdf[0]
        page.set_rotation(180)
        assert extract(page) is None


@pytest.mark.parametrize("section", ["header", "bottom", "column"])
def test_filled_subsection_cannot_replace_unfilled_native_cells(tmp_path, section):
    c = canvas.Canvas(str(tmp_path / "partial.pdf"), pagesize=(400, 300))
    for row in range(4):
        for column in range(2):
            filled = {
                "header": row == 0,
                "bottom": row == 3,
                "column": column == 0,
            }[section]
            x, y = 30 + column * 170, 210 - row * 50
            c.rect(x, y, 170, 50, fill=int(filled), stroke=int(not filled))
            c.drawString(x + 8, y + 20, f"Native cell {row}:{column}")
    c.save()
    with pdfium.PdfDocument(tmp_path / "partial.pdf") as pdf:
        assert extract(pdf[0]) is None


@pytest.mark.parametrize("error, accepted", [(2.5, True), (3.0, True), (3.01, False)])
def test_complete_grid_accepts_bounded_prediction_error(tmp_path, error, accepted):
    from smedc_pdf_parser.ruled_table import extract_filled_grid

    with pdfium.PdfDocument(filled_table(tmp_path / "complete.pdf")) as pdf:
        grid = extract_filled_grid(
            pdf[0], (30 - error, 40 - error, 370 + error, 240 + error)
        )
    if not accepted:
        assert grid is None
        return
    assert grid is not None
    assert (grid["rowCount"], grid["columnCount"]) == (4, 2)
    assert len(grid["cells"]) == 7


def test_native_content_in_roi_margin_cannot_be_discarded(tmp_path):
    from smedc_pdf_parser.ruled_table import extract_filled_grid

    # The ROI tolerance is for empty prediction margins, not an extra column.
    with pdfium.PdfDocument(
        filled_table(tmp_path / "margin.pdf", margin_text=True)
    ) as pdf:
        assert extract_filled_grid(pdf[0], (27.5, 37.5, 372.5, 242.5)) is None


def test_recovery_retains_both_distinct_native_cell_texts(tmp_path):
    from smedc_pdf_parser.convert import _ruled_table

    source = filled_table(tmp_path / "native.pdf")
    size = SimpleNamespace(width=400, height=300)
    predicted = SimpleNamespace(
        table_cells=[SimpleNamespace(text="Group", column_header=True)]
    )
    try:
        table = _ruled_table(
            source,
            1,
            dict(left=29 / 400, top=39 / 300, right=371 / 400, bottom=241 / 300),
            size,
            [],
            None,
            predicted,
            repair_invalid_prediction=True,
        )
    except TypeError:
        pytest.fail("Invalid-prediction native geometry fallback is missing")
    assert table is not None
    assert (
        next(c for c in table["cells"] if c["row"] == 1 and c["column"] == 0)["text"]
        == "Upper merged"
    )
    assert (
        next(c for c in table["cells"] if c["row"] == 3 and c["column"] == 0)["text"]
        == "Lower separate"
    )
    assert table["headerRows"] == [0]
