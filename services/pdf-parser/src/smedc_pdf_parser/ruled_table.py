"""Prefer explicit PDF ruling over a model's guessed merged-cell structure.

Only straight, narrow native paths are eligible. Raster/unruled tables keep the
qualified TableFormer result. Reject incomplete or nonrectangular grids.
"""

from __future__ import annotations

import math

import pypdfium2 as pdfium


def extract_vector_grid(page, bbox: tuple[float, float, float, float]) -> dict | None:
    # Object/glyph bounds use the original PDF canvas. Rendering and Docling
    # boxes use the displayed page. Until all native operations share a full
    # affine transform, leave rotated/cropped/translated pages to TableFormer.
    if page.get_rotation() != 0:
        return None
    width, height = page.get_size()
    expected = (0, 0, width, height)
    for page_box in (
        page.get_bbox(),  # inherits page-tree boxes, unlike get_*box in PDFium
        page.get_mediabox(fallback_ok=False),
        page.get_cropbox(fallback_ok=False),
    ):
        if page_box is not None and not all(
            math.isclose(actual, wanted, rel_tol=0, abs_tol=0.01)
            for actual, wanted in zip(page_box, expected)
        ):
            return None
    left, top, right, bottom = bbox
    horizontal, vertical = [], []
    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH]):
        if pdfium.raw.FPDFPath_CountSegments(obj) > 5:
            continue
        line_left, b, r, t = obj.get_bounds()
        t, b = height - t, height - b
        if line_left < left - 3 or r > right + 3 or t < top - 3 or b > bottom + 3:
            continue
        if b - t <= 3 and r - line_left >= 25:
            horizontal.append(((t + b) / 2, line_left, r))
        elif r - line_left <= 3 and b - t >= 25:
            vertical.append(((line_left + r) / 2, t, b))

    def cluster(values):
        groups = []
        for value in sorted(values):
            if not groups or value - groups[-1][-1] > 2:
                groups.append([value])
            else:
                groups[-1].append(value)
        return [sum(group) / len(group) for group in groups]

    xs, ys = cluster(v[0] for v in vertical), cluster(h[0] for h in horizontal)
    if not 3 <= len(xs) <= 65 or not 3 <= len(ys) <= 257:
        return None
    rows, columns = len(ys) - 1, len(xs) - 1
    if rows * columns > 4096:
        return None

    def boundary(lines, pos, start, end):
        spans = sorted(
            (max(start, a), min(end, b))
            for p, a, b in lines
            if abs(p - pos) <= 2 and b > start and a < end
        )
        cursor = start
        for a, b in spans:
            if a > cursor + 3:
                return False
            cursor = max(cursor, b)
        return cursor >= end - 3

    if not all(
        (
            boundary(horizontal, ys[0], xs[0], xs[-1]),
            boundary(horizontal, ys[-1], xs[0], xs[-1]),
            boundary(vertical, xs[0], ys[0], ys[-1]),
            boundary(vertical, xs[-1], ys[0], ys[-1]),
        )
    ):
        return None
    parents = list(range(rows * columns))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    def join(a, b):
        parents[root(a)] = root(b)

    for row in range(rows):
        for column in range(columns):
            i = row * columns + column
            if column + 1 < columns and not boundary(
                vertical, xs[column + 1], ys[row], ys[row + 1]
            ):
                join(i, i + 1)
            if row + 1 < rows and not boundary(
                horizontal, ys[row + 1], xs[column], xs[column + 1]
            ):
                join(i, i + columns)
    groups = {}
    for i in range(rows * columns):
        groups.setdefault(root(i), []).append(divmod(i, columns))
    cells = []
    for group in groups.values():
        first_row, last_row = min(r for r, c in group), max(r for r, c in group)
        first_col, last_col = min(c for r, c in group), max(c for r, c in group)
        if len(group) != (last_row - first_row + 1) * (last_col - first_col + 1):
            return None
        cells.append(
            {
                "row": first_row,
                "column": first_col,
                "rowSpan": last_row - first_row + 1,
                "columnSpan": last_col - first_col + 1,
                "bboxPoints": (
                    xs[first_col],
                    ys[first_row],
                    xs[last_col + 1],
                    ys[last_row + 1],
                ),
            }
        )
    cells.sort(key=lambda cell: (cell["row"], cell["column"]))
    return {"cells": cells, "rowCount": rows, "columnCount": columns}
