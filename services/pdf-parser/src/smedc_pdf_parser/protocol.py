"""Version-one worker DTO validation; keep aligned with domain/pdf-evidence.ts."""

from __future__ import annotations

import math
import re


def _check(condition):
    if not condition:
        raise ValueError("PDF_INVALID_RESULT")


def _object(value, allowed=None, required=()):
    _check(type(value) is dict)
    if allowed is not None:
        _check(set(value) <= set(allowed))
    _check(set(required) <= set(value))
    return value


def _array(value):
    _check(type(value) is list)
    return value


def _text(value):
    _check(isinstance(value, str) and bool(value.strip()))
    return value


def _integer(value, low=0, high=9007199254740991):
    _check(type(value) is int and low <= value <= high)
    return value


def _bbox(value):
    fields = ("left", "top", "right", "bottom")
    _object(value, fields, fields)
    for coordinate in value.values():
        _check(
            type(coordinate) in (int, float)
            and math.isfinite(coordinate)
            and 0 <= coordinate <= 1
        )
    _check(value["left"] <= value["right"] and value["top"] <= value["bottom"])


def _location(value, count):
    _object(
        value,
        (
            "pageNumber",
            "bbox",
            "method",
            "startLine",
            "endLine",
            "blockOrdinal",
            "tableRow",
            "tableCell",
        ),
        ("pageNumber", "method"),
    )
    _integer(value["pageNumber"], 1, count)
    _check(value["method"] in ("native", "ocr"))
    if "bbox" in value:
        _bbox(value["bbox"])
    for field in ("startLine", "endLine", "blockOrdinal", "tableRow", "tableCell"):
        if field in value:
            _integer(value[field])
    if "startLine" in value and "endLine" in value:
        _check(value["endLine"] >= value["startLine"])


def validate_table(table):
    """Validate before any row/grid expansion, counting JS UTF-16 string units."""
    fields = ("id", "cells", "headerRows", "rowCount", "columnCount")
    _object(table, fields, fields)
    _text(table["id"])
    rows = _integer(table["rowCount"], 1, 1024)
    columns = _integer(table["columnCount"], 1, 128)
    _check(rows * columns <= 16384)
    headers = _array(table["headerRows"])
    for header in headers:
        _integer(header, 0, rows - 1)
    _check(len(set(headers)) == len(headers))
    cells = _array(table["cells"])
    _check(0 < len(cells) <= 4096)
    expanded = 0
    occupied = set()
    for cell in cells:
        fields = ("row", "column", "rowSpan", "columnSpan", "text")
        _object(cell, fields, fields)
        row = _integer(cell["row"], 0, rows - 1)
        column = _integer(cell["column"], 0, columns - 1)
        rs = _integer(cell["rowSpan"], 1, rows - row)
        cs = _integer(cell["columnSpan"], 1, columns - column)
        _check(isinstance(cell["text"], str))
        expanded += (
            len(cell["text"].encode("utf-16-le", errors="surrogatepass")) // 2 * rs * cs
        )
        _check(expanded <= 4 * 1024 * 1024)
        for r in range(row, row + rs):
            for c in range(column, column + cs):
                _check((r, c) not in occupied)
                occupied.add((r, c))
    return rows * columns, expanded


def validate_result(value):
    fields = (
        "schemaVersion",
        "sourceChecksumSha256",
        "parserFingerprint",
        "pageCount",
        "pages",
        "blocks",
        "tables",
        "pictures",
        "warnings",
    )
    _object(value, fields, fields)
    _check(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    _check(
        isinstance(value["sourceChecksumSha256"], str)
        and re.fullmatch("[a-f0-9]{64}", value["sourceChecksumSha256"])
    )
    _text(value["parserFingerprint"])
    count = _integer(value["pageCount"], 1, 200)
    pages = _array(value["pages"])
    _check(len(pages) == count)
    page_ids = set()
    for page in pages:
        _object(page, ("pageNumber", "outcome"), ("pageNumber", "outcome"))
        number = _integer(page["pageNumber"], 1, count)
        _check(number not in page_ids)
        page_ids.add(number)
        _check(page["outcome"] in ("parsed", "blank", "image_only", "failed"))
    tables = {}
    grid = expanded = 0
    for table in _array(value["tables"]):
        slots, chars = validate_table(table)
        grid += slots
        expanded += chars
        _check(grid <= 65536 and expanded <= 16 * 1024 * 1024)
        _check(table["id"] not in tables)
        tables[table["id"]] = table
    blocks = {}
    referenced = set()
    text_pages = set()
    for block in _array(value["blocks"]):
        fields = (
            "blockId",
            "blockType",
            "text",
            "headingPath",
            "sourceLocation",
            "metadata",
        )
        _object(block, fields, fields)
        identifier = _text(block["blockId"])
        _check(identifier not in blocks)
        blocks[identifier] = block
        _check(block["blockType"] in ("heading", "paragraph", "list", "table", "code"))
        _text(block["text"])
        for heading in _array(block["headingPath"]):
            _text(heading)
        _location(block["sourceLocation"], count)
        text_pages.add(block["sourceLocation"]["pageNumber"])
        metadata = _object(block["metadata"])
        _check(metadata.get("sourceType") != "generated_description")
        if block["blockType"] == "table":
            table_id = _text(metadata.get("tableId"))
            _check(table_id in tables)
            last = tables[table_id]["rowCount"] - 1
            start = _integer(metadata.get("rowStart"), 0, last)
            _integer(metadata.get("rowEnd"), start, last)
            referenced.add(table_id)
        else:
            _check("tableId" not in metadata)
    _check(referenced == set(tables))
    picture_ids = set()
    picture_pages = set()
    for picture in _array(value["pictures"]):
        fields = ("id", "pageNumber", "bbox", "caption", "ocrBlockIds")
        _object(picture, fields, fields)
        identifier = _text(picture["id"])
        _check(identifier not in picture_ids)
        picture_ids.add(identifier)
        number = _integer(picture["pageNumber"], 1, count)
        picture_pages.add(number)
        _bbox(picture["bbox"])
        _check(picture["caption"] is None or isinstance(picture["caption"], str))
        linked = set()
        for identifier in _array(picture["ocrBlockIds"]):
            _text(identifier)
            _check(identifier not in linked and identifier in blocks)
            linked.add(identifier)
            location = blocks[identifier]["sourceLocation"]
            _check(location["pageNumber"] == number and location["method"] == "ocr")
    for page in pages:
        number, outcome = page["pageNumber"], page["outcome"]
        if outcome == "parsed":
            _check(number in text_pages)
        if outcome == "blank":
            _check(number not in text_pages and number not in picture_pages)
        if outcome == "image_only":
            _check(number not in text_pages and number in picture_pages)
    for warning in _array(value["warnings"]):
        _object(warning, ("code", "message", "sourceLocation"), ("code", "message"))
        _text(warning["code"])
        _text(warning["message"])
        if "sourceLocation" in warning:
            _location(warning["sourceLocation"], count)
    return value
