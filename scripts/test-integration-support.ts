import type { PartitionDatasetName } from "@smedc/domain";
import { parse as parseCsv } from "csv-parse/sync";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { COST_CARD_UPLOAD_SCHEMA } from "@smedc/domain";
import { createDatabaseAdapter } from "@smedc/db";
import { downloadPartitionBundle } from "../apps/mcp-launcher/src/partition-bundle.js";
import {
  apiJson,
  downloadPartitionDataset,
  type PartitionTransferContext
} from "../apps/mcp-launcher/src/partition-transfer.js";

/** Small original export: numeric XML, decimal text, percentage styles and duplicate rows. */
export async function createCostCardIntegrationFixture() {
  const standard: Record<string, string> = {
    spu_id: "0001",
    sku_id: "0012",
    dish_name: "合成精度锅",
    base_category_name: "合成测试",
    production_quantity: "1.25",
    sale_price: "99999999999999.123456",
    specification_name: "小锅",
    has_cost_card: "true",
    material_cost_tax_included: "12.345678",
    other_cost: "0",
    target_gross_margin_rate: "0.823456",
    recipe_type: "全局（标准配方）",
    recipe_name: "合成标准",
    total_cost_tax_included: "12.345678",
    gross_margin_rate_tax_included: "0.912345",
    item_code: "0007",
    item_name: "合成盐",
    item_spec: "合成规格",
    cost_unit: "kg",
    net_quantity: "99999999999999.000001",
    yield_rate: "0.823456",
    gross_quantity: "0.000001",
    consumption_unit_price_tax_included: "99999999999999.123456",
    consumption_amount_tax_included: "0.000001",
    is_main_material: "true",
    is_semi_finished: "false",
    is_prepared: "true",
    uses_auxiliary_unit_deduction: "false",
    base_unit: "克",
    base_gross_quantity: "0",
    substitute_material_text: "合成替代",
    store_can_modify: "false",
    source_dish_deleted: "false",
    remark: "合成备注,含逗号\n第二行",
    source_stores_text: ""
  };
  const rows = [
    { spu_id: "0001", sku_id: "0012", specification_name: "小锅" },
    { spu_id: "0001", sku_id: "0013", specification_name: "大锅" },
    { spu_id: "0002", sku_id: "0012", specification_name: "独立SPU" }
  ].flatMap((identity) => {
    const row: Record<string, string> = { ...standard, ...identity };
    return [
      row,
      { ...row },
      {
        ...row,
        recipe_type: "特定（例外配方）",
        recipe_name: "合成例外",
        net_quantity: "0",
        source_stores_text: "合成甲店；合成乙店"
      }
    ];
  });
  const headers = COST_CARD_UPLOAD_SCHEMA.map((field) => field.sourceColumn);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("成本卡合成");
  sheet.addRow(headers);
  rows.forEach((row) => {
    const excelRow = sheet.addRow(
      COST_CARD_UPLOAD_SCHEMA.map((field) => row[field.canonicalName]!)
    );
    excelRow.getCell(6).value = 1;
    excelRow.getCell(21).value = 1;
    excelRow.getCell(21).numFmt = "0.0000%";
    excelRow.getCell(23).value = 1;
    excelRow.getCell(11).value = "82.3456%";
    excelRow.getCell(15).value = "91.2345%";
  });
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const entry = zip.file("xl/worksheets/sheet1.xml")!;
  let xml = await entry.async("string");
  rows.forEach((row, index) => {
    for (const [column, value] of [
      ["F", row.sale_price],
      ["U", row.yield_rate],
      ["W", row.consumption_unit_price_tax_included]
    ]) {
      xml = xml.replace(
        new RegExp(`(<c r="${column}${index + 2}"[^>]*><v>)[^<]+(</v>)`),
        `$1${value}$2`
      );
    }
  });
  zip.file(entry.name, xml);
  const csvCell = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const csv =
    [
      headers,
      ...rows.map((row) => COST_CARD_UPLOAD_SCHEMA.map((field) => row[field.canonicalName]!))
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\n") + "\n";
  return {
    xlsx: await zip.generateAsync({ type: "nodebuffer" }),
    csv: Buffer.from(csv),
    rows,
    headers,
    sheetName: sheet.name
  };
}

/** A tiny original settled-order export, independent of the runtime field registry. */
export async function createSettledOrderIntegrationFixture(
  overrides?: Array<Record<string, string>>
) {
  const headers = [
    "门店",
    "机构编码",
    "营业日期",
    "订单号",
    "经营模式",
    "订单来源",
    "用餐方式",
    "下单时间",
    "结账时间",
    "退单时间",
    "取餐号",
    "桌牌号",
    "全渠道流水号",
    "桌台区域",
    "用餐人数",
    "订单金额（元）",
    "顾客应付（元）",
    "支付合计（元）",
    "订单优惠（元）",
    "订单收入（元）",
    "结账方式",
    "订单状态",
    "退单标识",
    "菜品收入（元）",
    "服务费（元）",
    "服务费优惠（元）",
    "服务费收入（元）",
    "预定用餐时间",
    "会员",
    "整单备注"
  ];
  const base = {
    门店: "合成甲店",
    机构编码: "0007",
    营业日期: "20261027",
    订单号: "000012",
    下单时间: "2026-10-28 00:03",
    退单时间: "--",
    取餐号: "--",
    用餐人数: "--",
    "订单金额（元）": "12.30",
    "订单收入（元）": "12.30",
    结账方式: "员工 卡 10.00，现金 -2.30(退款)，现金 -2.30(退款)，现金 -0.10（找零）",
    订单状态: "来源新状态",
    会员: "来源文本",
    整单备注: '合成,含"引号"\n第二行'
  };
  const rows: Array<Record<string, string>> = overrides ?? [
    { ...base },
    { ...base },
    { ...base, 营业日期: "20261026", 结账方式: "--", "订单收入（元）": "5" },
    { ...base, 门店: "合成乙店", 订单号: "000013", 结账方式: "现金 8", "订单收入（元）": "8" }
  ];
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("已结账合成");
  sheet.addRow(["店内订单明细—已结账（合成）"]);
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(headers.map((header) => row[header] ?? "")));
  return { headers, rows, xlsx: Buffer.from(await book.xlsx.writeBuffer()) };
}

export async function createTakeawayOrderIntegrationFixture(
  overrides?: Array<Record<string, string>>
) {
  const headers =
    "门店,机构编码,订单来源,外卖订单号,收银订单号,订单状态,订单形式,退单标识,取餐号,全渠道流水号,营业日期,下单时间,接单时间,完成时间,取消时间,退单时间,配送方式,菜品总价(元),餐盒费(元),配送费(元),订单金额(元),配送费(商家收入)(元),外卖营业额(元),平台服务费(元),商家活动支出(元),其他支出(元),本单预计收入(原)(元),部分退款(元),营业优惠/支出(元),营业收入(元),顾客实付(元),餐盒费优惠(元),餐盒费收入(元)".split(
      ","
    );
  const base = {
    门店: "合成甲店",
    机构编码: "0007",
    营业日期: "20261027",
    外卖订单号: "000012",
    收银订单号: "000900719925474099312345",
    全渠道流水号: "000000009",
    订单来源: "平台甲",
    下单时间: "2026-10-28 00:03",
    接单时间: "--",
    完成时间: "--",
    退单时间: "2026-10-29 01:00",
    取餐号: "--",
    订单状态: "制作中",
    订单形式: "新形式",
    退单标识: "部分退款",
    配送方式: '未知配送,含"引号"\n第二行',
    "订单金额(元)": "12.30",
    "营业收入(元)": "12.30",
    "部分退款(元)": "-2.30",
    "平台服务费(元)": "-0.10",
    "餐盒费(元)": "0",
    "配送费(元)": "--"
  };
  const rows: Array<Record<string, string>> = overrides ?? [
    { ...base },
    { ...base },
    { ...base, 营业日期: "20261026", "营业收入(元)": "5" },
    { ...base, 门店: "合成乙店", 外卖订单号: "000013", "营业收入(元)": "8" },
    { ...base, 订单来源: "未来平台乙", 订单状态: "配送中", "营业收入(元)": "2" }
  ];
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("有效外卖合成");
  sheet.addRow(["平台外卖订单明细—有效订单（合成）"]);
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(headers.map((header) => row[header] ?? "")));
  return { headers, rows, xlsx: Buffer.from(await book.xlsx.writeBuffer()) };
}

export function integrationDatabasePlan(baseUrl: string, mysqlPort: string) {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("Integration database must use an explicit loopback MySQL URL.");
  }
  assert(
    base.protocol === "mysql:" &&
      ["localhost", "127.0.0.1"].includes(base.hostname) &&
      /^[1-9]\d{0,4}$/.test(mysqlPort) &&
      Number(mysqlPort) <= 65535 &&
      (base.port || "3306") === mysqlPort &&
      base.search === "" &&
      base.hash === "" &&
      /^\/[a-zA-Z0-9_]+$/.test(base.pathname),
    "Integration database URL must match the loopback MYSQL_PORT without overrides."
  );
  const schema = `smedc_integration_${randomUUID().replaceAll("-", "")}`;
  const database = new URL(base);
  database.pathname = `/${schema}`;
  return { schema, databaseUrl: database.href, baseUrl: base.href };
}

export async function createOwnedIntegrationDatabase(baseUrl: string, mysqlPort: string) {
  const plan = integrationDatabasePlan(baseUrl, mysqlPort);
  const connect = () => new PrismaClient({ adapter: createDatabaseAdapter(plan.baseUrl) });
  const prisma = connect();
  try {
    // No IF NOT EXISTS: only a successful new CREATE establishes ownership.
    await prisma.$executeRawUnsafe(`CREATE DATABASE \`${plan.schema}\``);
  } finally {
    await prisma.$disconnect();
  }
  let owned = true;
  return {
    schema: plan.schema,
    databaseUrl: plan.databaseUrl,
    async cleanup() {
      if (!owned) return;
      const cleanup = connect();
      try {
        await cleanup.$executeRawUnsafe(`DROP DATABASE \`${plan.schema}\``);
        owned = false;
      } finally {
        await cleanup.$disconnect();
      }
    }
  };
}

interface LocalExtract {
  localDirectory: string;
  partitionCount: number;
  totalRowCount: number;
  files: string[];
}

async function summarizeExtract(extract: LocalExtract, amountColumn: string) {
  const manifest = await readFile(path.join(extract.localDirectory, "manifest.json"), "utf8");
  assert(
    !manifest.includes("presignedDownloadUrl") &&
      !manifest.includes("downloadUrl") &&
      !manifest.includes("structured-partitions/") &&
      !manifest.includes("partition-downloads/"),
    "Local manifests must not retain capabilities or storage object keys."
  );
  const csvHashes: string[] = [];
  let rowCount = 0;
  let amountCents = 0;
  for (const file of extract.files) {
    const bytes = await readFile(path.join(extract.localDirectory, file));
    csvHashes.push(createHash("sha256").update(bytes).digest("hex"));
    const [header, ...rows] = parseCsv(bytes) as string[][];
    const amountIndex = header!.indexOf(amountColumn);
    assert(amountIndex >= 0, "Synthetic CSV must contain the aggregate column.");
    for (const row of rows) {
      const value = row[amountIndex]!;
      assert(/^\d+(\.\d{1,2})?$/.test(value), "Synthetic amount must be exact decimal money.");
      const [units, fraction = ""] = value.split(".");
      amountCents += Number(units) * 100 + Number(fraction.padEnd(2, "0"));
      rowCount++;
    }
  }
  assert.equal(extract.files.length, extract.partitionCount);
  assert.equal(rowCount, Number(extract.totalRowCount));
  return {
    partitionCount: extract.partitionCount,
    rowCount,
    amountCents,
    csvHashes: csvHashes.sort()
  };
}

export async function comparePartitionDownloads(input: {
  context: PartitionTransferContext;
  scope: {
    dataset: PartitionDatasetName;
    enterpriseName: string;
    startDate: string;
    endDate: string;
  };
  amountColumn: string;
  expected: { partitionCount: number; rowCount: number; amountCents: number };
  build: (requestId: string) => Promise<void>;
}) {
  const directories: string[] = [];
  const counts = () => ({ apiRequests: 0, payloadHttpRequests: 0 });
  let requests = counts();
  const context = {
    ...input.context,
    fetchImplementation: ((resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.pathname.startsWith("/v1/")) requests.apiRequests++;
      else requests.payloadHttpRequests++;
      return input.context.fetchImplementation(resource, init);
    }) as typeof fetch
  };
  try {
    const legacyStart = performance.now();
    const legacy = (await downloadPartitionDataset({
      context,
      ...input.scope,
      startDate: input.scope.startDate.replaceAll("-", ""),
      endDate: input.scope.endDate.replaceAll("-", "")
    })) as LocalExtract;
    directories.push(legacy.localDirectory);
    const oldTiming = performance.now() - legacyStart;
    const oldRequests = { ...requests, transferOperations: legacy.files.length };
    const oldSummary = await summarizeExtract(legacy, input.amountColumn);

    requests = counts();
    const bundleStart = performance.now();
    const prepared = (await apiJson(context, "/v1/structured/partition-downloads", {
      method: "POST",
      body: { ...input.scope, idempotencyKey: `comparison-${randomUUID()}` }
    })) as { requestId: string };
    const buildStart = performance.now();
    await input.build(prepared.requestId);
    const buildMs = performance.now() - buildStart;
    const status = (await apiJson(
      context,
      `/v1/structured/partition-downloads/${prepared.requestId}`,
      { method: "GET" }
    )) as { status: string };
    assert.equal(status.status, "succeeded");
    const bundled = (await downloadPartitionBundle({
      context,
      requestId: prepared.requestId
    })) as LocalExtract;
    directories.push(bundled.localDirectory);
    const bundleTiming = performance.now() - bundleStart;
    const newRequests = { ...requests, transferOperations: bundled.partitionCount ? 1 : 0 };
    const newSummary = await summarizeExtract(bundled, input.amountColumn);
    assert.deepEqual(
      newSummary,
      oldSummary,
      "ZIP and legacy must preserve every CSV and aggregate."
    );
    const { csvHashes, ...actual } = oldSummary;
    assert.deepEqual(actual, input.expected);
    return {
      ...actual,
      csvHashes,
      legacy: { ...oldRequests, elapsedMs: Math.round(oldTiming) },
      zip: { ...newRequests, elapsedMs: Math.round(bundleTiming), buildMs: Math.round(buildMs) }
    };
  } finally {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true }))
    );
  }
}
