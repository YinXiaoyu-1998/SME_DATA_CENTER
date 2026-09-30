"""Shared worker DTO and bounded table expansion at the Python boundary."""

import copy
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures/evidence/pdf/contracts"


def validate(value):
    try:
        from smedc_pdf_parser.protocol import validate_result
    except ModuleNotFoundError:
        pytest.fail("Python PDF protocol validator is missing")
    return validate_result(value)


def fixture():
    return json.loads((FIXTURES / "valid-mixed.json").read_text())


def test_shared_valid_contract_roundtrips():
    value = fixture()
    assert validate(value) == value


def test_shared_duplicate_page_is_rejected():
    with pytest.raises(ValueError, match="^PDF_INVALID_RESULT$"):
        validate(json.loads((FIXTURES / "invalid-duplicate-page.json").read_text()))


@pytest.mark.parametrize(
    "change",
    ["grid", "expansion", "overlap", "reference", "description", "extra", "coordinate"],
)
def test_untrusted_result_rejected_before_chunk_allocation(change):
    value = copy.deepcopy(fixture())
    table = value["tables"][0]
    if change == "grid":
        table.update(rowCount=1024, columnCount=128)
    elif change == "expansion":
        table.update(
            rowCount=1024,
            columnCount=1,
            headerRows=[],
            cells=[dict(row=0, column=0, rowSpan=1024, columnSpan=1, text="😀" * 2049)],
        )
    elif change == "overlap":
        table["cells"][0]["rowSpan"] = 2
    elif change == "reference":
        value["pictures"][0]["ocrBlockIds"] = ["missing"]
    elif change == "description":
        value["blocks"][0]["metadata"]["sourceType"] = "generated_description"
    elif change == "extra":
        value["path"] = "/private/source.pdf"
    else:
        value["pictures"][0]["bbox"]["left"] = float("nan")
    with pytest.raises(ValueError, match="^PDF_INVALID_RESULT$"):
        validate(value)


def test_cumulative_grid_budget_is_finite():
    value = fixture()
    value["tables"] = []
    value["blocks"] = []
    for index in range(5):
        table = dict(
            id=f"table-{index}",
            rowCount=1024,
            columnCount=16,
            headerRows=[],
            cells=[dict(row=0, column=0, rowSpan=1, columnSpan=1, text="x")],
        )
        value["tables"].append(table)
        block = copy.deepcopy(fixture()["blocks"][0])
        block["blockId"] = f"block-{index}"
        block["metadata"] = dict(tableId=table["id"], rowStart=0, rowEnd=0)
        value["blocks"].append(block)
    value["pictures"][0]["ocrBlockIds"] = []
    with pytest.raises(ValueError, match="^PDF_INVALID_RESULT$"):
        validate(value)
