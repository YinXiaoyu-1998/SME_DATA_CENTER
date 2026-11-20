import path from "node:path";
import { readXlsxRows, type XlsxSheetRows } from "@smedc/structured-ingestion/xlsx-stream";
import {
  DISH_CATALOG_LIMITS,
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  DishCatalogValidationError,
  parseDishCatalogBatch,
  type DishCatalogRowInput,
  type DishComboComposition,
  type DishComboReplacement
} from "@smedc/domain";
import { errorToolResult, jsonToolResult } from "@smedc/mcp-contract";
import { readLocalUploadFile } from "./local-file.js";
import type { LauncherToolResult } from "./launcher.js";

const dishHeaders = [
  "菜品编码（SPUID）",
  "菜品编码（SKUID）",
  "菜品名称",
  "品牌",
  "基础分类",
  "一级分类编码",
  "二级分类编码",
  "规格名称",
  "售卖价"
];
const comboHeaders = [
  "套餐编码",
  "套餐名称",
  "套餐计价方式",
  "品牌名称",
  "售卖价",
  "分组名称",
  "分组类型",
  "分组可选份数",
  "菜品名称",
  "菜品数量",
  "菜品加价"
];

class WorkbookInputError extends Error {
  constructor(
    message: string,
    readonly details: { sheet: string; row?: number; field?: string; candidates?: string[] }
  ) {
    super(message);
  }
}

interface SourceRow {
  row: number;
  sheet: string;
  get(header: string): string;
}

function readSheet(workbook: XlsxSheetRows[], sheet: string, headers: string[]): SourceRow[] {
  const source = workbook.find((part) => part.name === sheet);
  if (!source) throw new WorkbookInputError("Required worksheet is missing.", { sheet });
  const headerIndex = source.rows.findIndex((row) =>
    headers.every((header) => row.includes(header))
  );
  if (headerIndex < 0) throw new WorkbookInputError("Missing required column headers.", { sheet });
  const headerRow = source.rows[headerIndex]!;
  const columns = new Map(headers.map((header) => [header, headerRow.indexOf(header)]));
  for (const [header, column] of columns)
    if (headerRow.lastIndexOf(header) !== column)
      throw new WorkbookInputError("Duplicate column header.", {
        sheet,
        row: headerIndex + 1,
        field: header
      });
  return source.rows.slice(headerIndex + 1).flatMap((cells, index) =>
    cells.some((cell) => cell !== "")
      ? [
          {
            sheet,
            row: headerIndex + index + 2,
            get: (field: string) => cells[columns.get(field)!] ?? ""
          }
        ]
      : []
  );
}

function indexCandidate(
  map: Map<string, DishCatalogRowInput[]>,
  key: string,
  row: DishCatalogRowInput
) {
  const candidates = map.get(key);
  if (candidates) candidates.push(row);
  else map.set(key, [row]);
}

function uniqueCandidate(candidates: DishCatalogRowInput[], source: SourceRow, field: string) {
  if (candidates.length !== 1)
    throw new WorkbookInputError(
      candidates.length
        ? "Multiple catalog SKUs match the source."
        : "No catalog SKU matches the source.",
      {
        sheet: source.sheet,
        row: source.row,
        field,
        candidates: candidates.slice(0, 50).map((item) => item.skuId)
      }
    );
  return candidates[0]!;
}

/** Resolve every reference before sending the first independently atomic server batch. */
export async function parseDishCatalogWorkbook(bytes: Uint8Array, enterpriseName: string) {
  const workbook = await readXlsxRows(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    PHASE3_RUNTIME_LIMIT_DEFAULTS,
    {
      preserveNumericText: "canonical_integer",
      preserveNumberPadding: true,
      maxRows: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredImportRows,
      maxColumns: 256,
      maxMaterializedCells: 2_000_000
    }
  );
  const rows: DishCatalogRowInput[] = [];
  const seenSkus = new Set<string>();
  const bySpu = new Map<string, DishCatalogRowInput[]>();
  const byBrandAndName = new Map<string, DishCatalogRowInput[]>();
  const key = (brand: string, name: string) => JSON.stringify([brand, name]);
  for (const source of readSheet(workbook, "总部菜品", dishHeaders)) {
    const get = source.get;
    const row = {
      spuId: get("菜品编码（SPUID）"),
      skuId: get("菜品编码（SKUID）"),
      dishName: get("菜品名称"),
      brandName: get("品牌"),
      baseCategoryName: get("基础分类"),
      level1CategoryCode: get("一级分类编码"),
      level2CategoryCode: get("二级分类编码") || null,
      specificationName: get("规格名称") || null,
      salePrice: get("售卖价"),
      dishAlias: null,
      departmentName: null
    };
    try {
      parseDishCatalogBatch({ enterpriseName, rows: [row] });
    } catch (error) {
      if (!(error instanceof DishCatalogValidationError)) throw error;
      throw new WorkbookInputError("Invalid catalog value.", {
        sheet: source.sheet,
        row: source.row,
        field: error.details.field
      });
    }
    if (seenSkus.has(row.skuId))
      throw new WorkbookInputError("Duplicate catalog SKU.", {
        sheet: source.sheet,
        row: source.row
      });
    seenSkus.add(row.skuId);
    indexCandidate(bySpu, row.spuId, row);
    indexCandidate(byBrandAndName, key(row.brandName, row.dishName), row);
    if (row.specificationName)
      indexCandidate(
        byBrandAndName,
        key(row.brandName, row.dishName + "-" + row.specificationName),
        row
      );
    rows.push(row);
  }
  const replacements = new Map<string, DishComboReplacement>();
  const childSources: Array<{ skuId: string; row: number }> = [];
  for (const source of readSheet(workbook, "总部套餐", comboHeaders)) {
    const get = source.get;
    const fail = (message: string, field: string): never => {
      throw new WorkbookInputError(message, { sheet: source.sheet, row: source.row, field });
    };
    const brand = get("品牌名称");
    const code = get("套餐编码");
    const candidates = bySpu.get(code) ?? [];
    const parent = uniqueCandidate(
      candidates.filter((item) => item.brandName === brand),
      source,
      "套餐编码"
    );
    const child = uniqueCandidate(
      byBrandAndName.get(key(brand, get("菜品名称"))) ?? [],
      source,
      "菜品名称"
    );
    childSources.push({ skuId: child.skuId, row: source.row });
    const pricingMethod = get("套餐计价方式"),
      salePrice = get("售卖价");
    const entry = replacements.get(parent.skuId) ?? {
      skuId: parent.skuId,
      composition: { pricingMethod, salePrice, groups: [] } satisfies DishComboComposition
    };
    replacements.set(parent.skuId, entry);
    if (
      entry.composition.pricingMethod !== pricingMethod ||
      entry.composition.salePrice !== salePrice
    )
      fail("Inconsistent pricing for one combo.", "套餐计价方式");
    const name = get("分组名称"),
      kind = get("分组类型"),
      count = get("分组可选份数");
    const type =
      kind === "固定分组"
        ? "fixed"
        : kind === "可选分组"
          ? "optional"
          : fail("Unknown group type.", "分组类型");
    const chooseCount =
      type === "fixed" && count === "全部"
        ? null
        : type === "optional" && /^[1-9]\d*$/.test(count)
          ? Number(count)
          : fail("Invalid selection count.", "分组可选份数");
    const item = { skuId: child.skuId, quantity: get("菜品数量"), extraPrice: get("菜品加价") };
    const groups: DishComboComposition["groups"] = entry.composition.groups;
    const group = groups.find((candidate) => candidate.name === name);
    if (group) {
      if (group.type !== type || group.chooseCount !== chooseCount)
        fail("Inconsistent group definition.", "分组名称");
      group.items.push(item);
    } else groups.push({ name, type, chooseCount, items: [item] });
    // Report malformed values at their original row even when a parent spans many rows.
    try {
      parseDishCatalogBatch({
        enterpriseName,
        compositions: [
          {
            skuId: parent.skuId,
            composition: {
              pricingMethod,
              salePrice,
              groups: [{ name, type, chooseCount, items: [item] }]
            }
          }
        ]
      });
    } catch (error) {
      if (!(error instanceof DishCatalogValidationError)) throw error;
      fail("Invalid combo definition, quantity or price.", "分组名称");
    }
  }
  const nested = childSources.find((child) => replacements.has(child.skuId));
  if (nested)
    throw new WorkbookInputError("Nested combos are not supported.", {
      sheet: "总部套餐",
      row: nested.row,
      field: "菜品名称"
    });
  // Existing manually classified rows retain their type during the identity pass.
  // The composition pass promotes parents atomically with their full configuration.
  for (const row of rows) if (!replacements.has(row.skuId)) row.dishType = "single";
  return { rows, compositions: [...replacements.values()] };
}

export async function importDishCatalogWorkbook(
  enterpriseName: string,
  workbookPath: string,
  write: (batch: Record<string, unknown>) => Promise<LauncherToolResult>
): Promise<LauncherToolResult> {
  const sourceFileName = path.basename(workbookPath);
  const file = await readLocalUploadFile({
    name: sourceFileName,
    filePath: workbookPath,
    encoding: "path",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  if (!file.ok) return file.result;
  let parsed;
  try {
    parsed = await parseDishCatalogWorkbook(file.body, enterpriseName);
  } catch (error) {
    return errorToolResult(
      "DISH_CATALOG_INVALID_WORKBOOK",
      error instanceof WorkbookInputError ? error.message : "Cannot read catalog workbook.",
      error instanceof WorkbookInputError ? error.details : undefined
    );
  }
  const batches: Array<{
    phase: "rows" | "compositions";
    start: number;
    batch: Record<string, unknown>;
  }> = [];
  for (const phase of ["rows", "compositions"] as const) {
    const entries = parsed[phase];
    for (let start = 0; start < entries.length; start += DISH_CATALOG_LIMITS.maxBatchEntries) {
      const batch = {
        enterpriseName,
        sourceFileName,
        [phase]: entries.slice(start, start + DISH_CATALOG_LIMITS.maxBatchEntries),
        ...(phase === "rows" ? { preserveManualFields: true } : {})
      };
      try {
        parseDishCatalogBatch(batch);
      } catch {
        return errorToolResult("DISH_CATALOG_INVALID_WORKBOOK", "Invalid catalog batch.", {
          phase,
          start
        });
      }
      batches.push({ phase, start, batch });
    }
  }
  let completedBatches = 0;
  for (const { phase, start, batch } of batches) {
    const result = await write(batch);
    if (result.isError)
      return errorToolResult(
        "DISH_CATALOG_BATCH_FAILED",
        "Retry the corrected workbook. Previously completed batches remain committed.",
        {
          completedBatches,
          phase,
          start,
          ...(phase === "compositions"
            ? {
                parentSkuIds: parsed.compositions
                  .slice(start, start + DISH_CATALOG_LIMITS.maxBatchEntries)
                  .map((parent) => parent.skuId)
              }
            : {}),
          serviceError: result.content[0]?.text
        }
      );
    completedBatches++;
  }
  return jsonToolResult({
    skuCount: parsed.rows.length,
    comboCount: parsed.compositions.length,
    completedBatches
  });
}
