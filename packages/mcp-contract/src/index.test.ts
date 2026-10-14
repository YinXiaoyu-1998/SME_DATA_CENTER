import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STRUCTURED_QUERY_LIMITS } from "@smedc/domain";
import {
  SMEDC_MCP_TOOL_CONTRACTS,
  SMEDC_MCP_TOOL_NAMES,
  FILE_UPLOAD_ADMIN_REQUIRED_CODE,
  FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE,
  MCP_LOCAL_FILE_PATH_MAX_LENGTH,
  MCP_STRUCTURED_QUERY_LIMITS,
  MCP_UPLOAD_FILENAME_MAX_LENGTH,
  MCP_UPLOAD_MAX_BYTES,
  MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH,
  apiErrorToolResult,
  errorToolResult,
  launcherUploadFileInputSchema,
  launcherUploadFileInputShape,
  type SmedcMcpToolName,
  isMcpErrorBody,
  jsonToolResult,
  mcpToolContractSchema
} from "./index.js";

const contractsByName = new Map(
  SMEDC_MCP_TOOL_CONTRACTS.map((contract) => [contract.name, contract])
);

it("retains server admin-only upload authorization and explains fixed category authority", () => {
  expect(FILE_UPLOAD_ADMIN_REQUIRED_CODE).toBe("UPLOAD_ADMIN_REQUIRED");
  expect(FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE).toBe("File upload requires the admin role.");
  for (const tool of SMEDC_MCP_TOOL_CONTRACTS.filter((tool) => tool.name.startsWith("upload_")))
    expect(tool.description).toContain("Requires the admin role.");
  expect(
    (
      contractsByName.get("upload_structured_dataset")?.inputShape["confidentialityLevel"] as
        z.ZodType | undefined
    )?.description
  ).toContain("cannot override");
});

const validInputs = {
  smedc_get_current_user: {},
  smedc_list_skills: { q: "menu", category: "menu-analysis" },
  search_document_evidence: {
    query: "refund SOP",
    filters: {
      fileTypes: ["md", "txt", "docx"],
      documentIds: ["doc_1"]
    },
    limit: 10,
    cursor: "cursor_1"
  },
  list_structured_datasets: {},
  query_structured_dataset: {
    dataset: "dishes",
    select: ["business_date"],
    filter: {
      field: "matched_product_name",
      op: "contains",
      value: "roujiamo"
    },
    sort: [{ field: "business_date", direction: "asc" }],
    page: { limit: 20, cursor: null },
    groupBy: ["store_name"],
    aggregates: [{ op: "sum", field: "gmv", as: "gmv_total" }]
  },
  describe_structured_dataset_coverage: {
    dataset: "dishes"
  },
  upload_structured_dataset: {
    file: {
      name: "synthetic-dishes.csv",
      mediaType: "text/csv",
      encoding: "base64",
      contentBase64: "Y29sMSxjb2wyCg=="
    },
    dataset: "business",
    enterpriseName: "Synthetic",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "structured-retry-key",
    confidentialityLevel: 0
  },
  upload_evidence_document: {
    categoryId: "memo",
    scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
    file: {
      name: "sop.md",
      mediaType: "text/markdown",
      encoding: "base64",
      contentBase64: "IyBTT1AK"
    },
    title: "SOP",
    sourceSystem: "manual",
    confidentialityLevel: 0
  },
  upload_quarantine_certificate: {
    enterpriseName: "Enterprise",
    storeName: "Store A ",
    file: {
      name: "quarantine.png",
      mediaType: "image/png",
      encoding: "base64",
      contentBase64: "iVBORw0KGgo="
    },
    receiptId: "SH2608250117",
    idempotencyKey: "quarantine-retry-key",
    confidentialityLevel: 0
  },
  query_quarantine_certificates: {
    receiptIds: ["SH2608250117", "SH2608260003"]
  },
  archive_quarantine_certificates: {
    sourceDocumentId: "doc_1"
  },
  get_source_document_download_url: { sourceDocumentId: "doc_1" },
  get_evidence_document_status: { documentId: "doc_1" },
  get_import_status: { importBatchId: "imp_1" },
  get_partition_import_status: { partitionImportJobId: "pjob_1" },
  download_cost_cards: { enterpriseName: "Synthetic" },
  archive_cost_card: { costCardId: "cc_a" },
  prepare_structured_partition_download: {
    dataset: "business",
    enterpriseName: "Synthetic",
    startDate: "20261001",
    endDate: "20261002",
    idempotencyKey: "idem-1"
  },
  get_structured_partition_download_status: { requestId: "pd_1" },
  describe_ledger_pdf_coverage: { dates: ["2026-10-04"] },
  get_ledger_pdf_request_status: { requestId: "request-1", cursor: "opaque-cursor" },
  prepare_ledger_pdf_download: {
    storeNames: ["合成门店"],
    startDate: "2026-10-01",
    endDate: "2026-10-04",
    idempotencyKey: "zip-1"
  },
  get_ledger_pdf_download_url: { requestId: "request-1" },
  download_structured_partitions: {
    dataset: "business",
    enterpriseName: "Synthetic",
    startDate: "20260701",
    endDate: "20260731"
  },
  get_my_permissions: {},
  list_account_permissions: {},
  get_account_permissions: { employeeId: "actor" },
  update_account_permissions: {
    employeeId: "actor",
    expectedVersion: "7",
    clearance: 2,
    grants: []
  },
  list_business_categories: {},
  create_evidence_category: {
    id: "memo",
    name: "Memo",
    expectedVersion: "7",
    ownerships: ["group"],
    requiredDimensionIds: []
  },
  update_business_category: {
    categoryId: "business",
    name: "Business",
    expectedVersion: "7",
    confidentialityLevel: 1
  },
  list_business_dimensions: {},
  create_business_dimension: { id: "region", name: "Region", expectedVersion: "7" },
  update_business_dimension: { dimensionId: "region", name: "Region", expectedVersion: "7" },
  create_business_dimension_value: {
    dimensionId: "region",
    id: "east",
    name: "East",
    expectedVersion: "7"
  },
  update_business_dimension_value: {
    dimensionId: "region",
    valueId: "east",
    name: "East",
    expectedVersion: "7"
  },
  list_business_stores: {},
  update_business_store: { enterpriseKey: "enterprise", name: "Store A ", expectedVersion: "7" },
  update_evidence_document_attributes: {
    documentId: "doc",
    expectedVersion: "7",
    categoryId: "memo",
    fileConfidentialityLevel: 1,
    scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]
  },
  get_evidence_document_management_status: { documentId: "doc" },
  prepare_authorization_cutover: {},
  activate_authorization_cutover: { expectedVersion: "7", confirm: true },
  suspend_authorization_reads: { expectedVersion: "7", confirm: true }
} satisfies Record<SmedcMcpToolName, Record<string, unknown>>;

const invalidInputCases = [
  {
    tool: "smedc_get_current_user",
    cases: [{ label: "cross-employee selector", input: { employeeId: "someone-else" } }]
  },
  {
    tool: "smedc_list_skills",
    cases: [
      { label: "numeric query", input: { q: 42 } },
      { label: "empty category", input: { category: "" } }
    ]
  },
  {
    tool: "search_document_evidence",
    cases: [
      { label: "missing query", input: { limit: 10 } },
      { label: "empty query", input: { query: "" } },
      {
        label: "invalid evidence file type",
        input: { query: "refund", filters: { fileTypes: ["pdf"] } }
      },
      { label: "limit below range", input: { query: "refund", limit: 0 } },
      { label: "limit above range", input: { query: "refund", limit: 51 } },
      {
        label: "extra filter field",
        input: { query: "refund", filters: { extra: true } }
      }
    ]
  },
  {
    tool: "list_structured_datasets",
    cases: [{ label: "non-empty input", input: { unknown: true } }]
  },
  {
    tool: "query_structured_dataset",
    cases: [
      { label: "invalid dataset", input: { dataset: "orders" } },
      { label: "empty selected field", input: { dataset: "dishes", select: [""] } },
      {
        label: "too many selected fields",
        input: {
          dataset: "dishes",
          select: Array.from(
            { length: MCP_STRUCTURED_QUERY_LIMITS.maxSelectedFields + 1 },
            (_, index) => `field_${index}`
          )
        }
      },
      { label: "empty filter conjunction", input: { dataset: "dishes", filter: { and: [] } } },
      {
        label: "filter boolean depth above domain limit",
        input: {
          dataset: "dishes",
          filter: { not: { not: { not: { field: "store_name", op: "eq", value: "A" } } } }
        }
      },
      {
        label: "filter condition count above domain limit",
        input: {
          dataset: "dishes",
          filter: {
            and: Array.from(
              { length: MCP_STRUCTURED_QUERY_LIMITS.maxConditions + 1 },
              (_, index) => ({ field: "store_name", op: "eq", value: `store_${index}` })
            )
          }
        }
      },
      {
        label: "filter in values above domain limit",
        input: {
          dataset: "dishes",
          filter: {
            field: "store_name",
            op: "in",
            value: Array.from(
              { length: MCP_STRUCTURED_QUERY_LIMITS.maxInValues + 1 },
              (_, index) => `store_${index}`
            )
          }
        }
      },
      { label: "invalid page limit", input: { dataset: "dishes", page: { limit: 0 } } },
      {
        label: "detail page limit above domain row limit",
        input: { dataset: "dishes", page: { limit: MCP_STRUCTURED_QUERY_LIMITS.maxRows + 1 } }
      },
      {
        label: "aggregate page limit above domain group limit",
        input: {
          dataset: "dishes",
          groupBy: ["store_name"],
          aggregates: [{ op: "count", as: "rows" }],
          page: { limit: MCP_STRUCTURED_QUERY_LIMITS.maxAggregateGroups + 1 }
        }
      },
      {
        label: "extra sort field",
        input: {
          dataset: "dishes",
          sort: [{ field: "business_date", direction: "asc", extra: true }]
        }
      },
      {
        label: "too many sort fields",
        input: {
          dataset: "dishes",
          sort: [
            { field: "business_date", direction: "asc" },
            { field: "store_name", direction: "asc" },
            { field: "gmv", direction: "desc" }
          ]
        }
      },
      {
        label: "too many group-by fields",
        input: {
          dataset: "business",
          groupBy: ["store_name", "order_source", "meal_period", "business_date", "city"],
          aggregates: [{ op: "count", as: "rows" }]
        }
      },
      {
        label: "too many aggregates",
        input: {
          dataset: "dishes",
          aggregates: Array.from(
            { length: MCP_STRUCTURED_QUERY_LIMITS.maxAggregates + 1 },
            (_, index) => ({ op: "count", as: `count_${index}` })
          )
        }
      },
      {
        label: "invalid aggregate op",
        input: { dataset: "dishes", aggregates: [{ op: "median" }] }
      },
      {
        label: "weighted aggregate missing weight field",
        input: {
          dataset: "business",
          aggregates: [{ op: "weightedAvg", field: "discount_rate", as: "weighted_discount" }]
        }
      },
      {
        label: "non-weighted aggregate with weight field",
        input: {
          dataset: "business",
          aggregates: [
            {
              op: "avg",
              field: "discount_rate",
              weightField: "gross_sales_amount",
              as: "weighted_discount"
            }
          ]
        }
      },
      {
        label: "duplicate aggregate alias",
        input: {
          dataset: "business",
          aggregates: [
            { op: "sum", field: "order_revenue", as: "revenue" },
            { op: "avg", field: "discount_rate", as: "revenue" }
          ]
        }
      },
      {
        label: "aggregate alias collides with group field",
        input: {
          dataset: "business",
          groupBy: ["store_name"],
          aggregates: [{ op: "sum", field: "order_revenue", as: "store_name" }]
        }
      }
    ]
  },
  {
    tool: "describe_structured_dataset_coverage" as SmedcMcpToolName,
    cases: [
      { label: "invalid dataset", input: { dataset: "orders" } },
      { label: "missing dataset", input: {} },
      { label: "extra field", input: { dataset: "dishes", completeness: true } }
    ]
  },
  {
    tool: "upload_structured_dataset",
    cases: [
      { label: "missing inline file", input: { dataset: "dishes" } },
      {
        label: "invalid dataset",
        input: { ...validInputs.upload_structured_dataset, dataset: "orders" }
      },
      {
        label: "bad start date",
        input: { ...validInputs.upload_structured_dataset, startDate: "2026-07-01" }
      },
      {
        label: "empty idempotency key",
        input: { ...validInputs.upload_structured_dataset, idempotencyKey: "" }
      },
      {
        label: "out-of-range confidentiality level",
        input: { ...validInputs.upload_structured_dataset, confidentialityLevel: 4 }
      },
      {
        label: "extra inline file field",
        input: {
          ...validInputs.upload_structured_dataset,
          file: { ...validInputs.upload_structured_dataset.file, filePath: "/tmp/data.csv" }
        }
      }
    ]
  },
  {
    tool: "upload_evidence_document",
    cases: [
      { label: "missing inline file", input: { title: "SOP", confidentialityLevel: 0 } },
      { label: "empty title", input: { ...validInputs.upload_evidence_document, title: "" } },
      {
        label: "out-of-range confidentiality level",
        input: { ...validInputs.upload_evidence_document, confidentialityLevel: 4 }
      },
      {
        label: "non-string source system",
        input: { ...validInputs.upload_evidence_document, sourceSystem: 42 }
      },
      {
        label: "extra inline file field",
        input: {
          ...validInputs.upload_evidence_document,
          file: { ...validInputs.upload_evidence_document.file, path: "/tmp/sop.md" }
        }
      }
    ]
  },
  {
    tool: "upload_quarantine_certificate",
    cases: [
      { label: "missing inline file", input: { receiptId: "SH1", confidentialityLevel: 0 } },
      {
        label: "empty receipt id",
        input: { ...validInputs.upload_quarantine_certificate, receiptId: "" }
      },
      {
        label: "out-of-range confidentiality level",
        input: { ...validInputs.upload_quarantine_certificate, confidentialityLevel: 4 }
      }
    ]
  },
  {
    tool: "query_quarantine_certificates",
    cases: [
      { label: "missing receipt ids", input: {} },
      { label: "empty receipt ids", input: { receiptIds: [] } }
    ]
  },
  {
    tool: "archive_quarantine_certificates",
    cases: [
      { label: "missing selector", input: {} },
      { label: "both selectors", input: { sourceDocumentId: "doc_1", receiptId: "SH1" } }
    ]
  },
  {
    tool: "get_source_document_download_url",
    cases: [
      { label: "missing source document id", input: {} },
      { label: "empty source document id", input: { sourceDocumentId: "" } }
    ]
  },
  {
    tool: "get_evidence_document_status",
    cases: [
      { label: "missing document id", input: {} },
      { label: "empty document id", input: { documentId: "" } }
    ]
  },
  {
    tool: "get_import_status",
    cases: [
      { label: "missing import batch id", input: {} },
      { label: "empty import batch id", input: { importBatchId: "" } }
    ]
  },
  {
    tool: "get_partition_import_status",
    cases: [
      { label: "missing partition job id", input: {} },
      { label: "empty partition job id", input: { partitionImportJobId: "" } }
    ]
  },
  {
    tool: "download_structured_partitions",
    cases: [
      { label: "missing range", input: { dataset: "business", enterpriseName: "Synthetic" } },
      {
        label: "invalid dataset",
        input: { ...validInputs.download_structured_partitions, dataset: "vip" }
      }
    ]
  },
  {
    tool: "download_cost_cards",
    cases: [
      { label: "empty IDs", input: { costCardIds: [] } },
      { label: "detail selector", input: { itemName: "盐" } }
    ]
  },
  {
    tool: "archive_cost_card",
    cases: [
      { label: "missing ID", input: {} },
      { label: "unsafe ID", input: { costCardId: "../a" } }
    ]
  },
  {
    tool: "prepare_structured_partition_download",
    cases: [
      { label: "missing range", input: {} },
      {
        label: "mixed selector",
        input: { ...validInputs.prepare_structured_partition_download, requestId: "pd_1" }
      },
      {
        label: "padded retry key",
        input: { ...validInputs.prepare_structured_partition_download, idempotencyKey: " padded " }
      }
    ]
  },
  {
    tool: "get_structured_partition_download_status",
    cases: [
      { label: "missing request", input: {} },
      { label: "empty request", input: { requestId: "" } }
    ]
  },
  ...(
    [
      "describe_ledger_pdf_coverage",
      "get_ledger_pdf_request_status",
      "prepare_ledger_pdf_download",
      "get_ledger_pdf_download_url"
    ] as const
  ).map((tool) => ({
    tool,
    cases: [
      { label: "missing required selectors", input: {} },
      { label: "organization selector", input: { ...validInputs[tool], orgId: "other-org" } }
    ]
  })),
  ...(
    [
      "get_my_permissions",
      "list_account_permissions",
      "get_account_permissions",
      "update_account_permissions",
      "list_business_categories",
      "create_evidence_category",
      "update_business_category",
      "list_business_dimensions",
      "create_business_dimension",
      "update_business_dimension",
      "create_business_dimension_value",
      "update_business_dimension_value",
      "list_business_stores",
      "update_business_store",
      "update_evidence_document_attributes",
      "get_evidence_document_management_status",
      "prepare_authorization_cutover",
      "activate_authorization_cutover",
      "suspend_authorization_reads"
    ] as const
  ).map((tool) => ({
    tool,
    cases: [{ label: "organization selector", input: { ...validInputs[tool], orgId: "other-org" } }]
  }))
] satisfies Array<{
  tool: SmedcMcpToolName;
  cases: Array<{ label: string; input: unknown }>;
}>;

describe("SMEDC MCP contract", () => {
  it("exports the stable business tool names without local-session tools", () => {
    expect(SMEDC_MCP_TOOL_NAMES).toEqual([
      "smedc_get_current_user",
      "smedc_list_skills",
      "search_document_evidence",
      "list_structured_datasets",
      "query_structured_dataset",
      "describe_structured_dataset_coverage",
      "upload_structured_dataset",
      "upload_evidence_document",
      "upload_quarantine_certificate",
      "query_quarantine_certificates",
      "archive_quarantine_certificates",
      "get_source_document_download_url",
      "get_evidence_document_status",
      "get_import_status",
      "get_partition_import_status",
      "download_structured_partitions",
      "download_cost_cards",
      "archive_cost_card",
      "prepare_structured_partition_download",
      "get_structured_partition_download_status",
      "describe_ledger_pdf_coverage",
      "get_ledger_pdf_request_status",
      "prepare_ledger_pdf_download",
      "get_ledger_pdf_download_url",
      "get_my_permissions",
      "list_account_permissions",
      "get_account_permissions",
      "update_account_permissions",
      "list_business_categories",
      "create_evidence_category",
      "update_business_category",
      "list_business_dimensions",
      "create_business_dimension",
      "update_business_dimension",
      "create_business_dimension_value",
      "update_business_dimension_value",
      "list_business_stores",
      "update_business_store",
      "update_evidence_document_attributes",
      "get_evidence_document_management_status",
      "prepare_authorization_cutover",
      "activate_authorization_cutover",
      "suspend_authorization_reads"
    ]);
    expect(
      SMEDC_MCP_TOOL_NAMES.filter((toolName) => toolName === "describe_structured_dataset_coverage")
    ).toHaveLength(1);

    const legacyPrefix = ["enterprise", "hub"].join("_");
    expect(SMEDC_MCP_TOOL_NAMES).not.toEqual(
      expect.arrayContaining([
        `${legacyPrefix}_get_current_user`,
        `${legacyPrefix}_list_skills`,
        `${legacyPrefix}_login`,
        `${legacyPrefix}_logout`,
        `${legacyPrefix}_auth_status`
      ])
    );
    expect(SMEDC_MCP_TOOL_NAMES).not.toContain("smedc_login_dev");
  });

  it("defines a zero-input current-user tool with a minimal self-profile result", () => {
    const currentUser = SMEDC_MCP_TOOL_CONTRACTS.find(
      (contract) => String(contract.name) === "smedc_get_current_user"
    );

    expect(currentUser?.inputSchema.safeParse({}).success).toBe(true);
    expect(currentUser?.inputSchema.safeParse({ employeeId: "someone-else" }).success).toBe(false);
    expect(currentUser?.resultShape).toEqual([
      "user: { displayName, email, role, clearance, organizationName }"
    ]);
  });

  it("describes structured uploads as queued work and status as the async completion view", () => {
    const structuredUpload = SMEDC_MCP_TOOL_CONTRACTS.find(
      (contract) => contract.name === "upload_structured_dataset"
    );
    const importStatus = SMEDC_MCP_TOOL_CONTRACTS.find(
      (contract) => contract.name === "get_import_status"
    );

    expect(structuredUpload?.description).toContain("202");
    expect(structuredUpload?.description).toContain("queued");
    expect(importStatus?.description).toContain("terminal");
    expect(importStatus?.resultShape).toEqual(["document", "processing", "importBatch"]);
  });

  it("declares automatic evidence source downloads and relevance pruning metadata", () => {
    const evidenceSearch = SMEDC_MCP_TOOL_CONTRACTS.find(
      (contract) => contract.name === "search_document_evidence"
    );

    expect(evidenceSearch?.resultShape).toEqual([
      "results[]: authorized evidence chunks and source-location metadata",
      "sources[]: one automatic download status/link per distinct returned document",
      "page",
      "retrieval: config versions, rerank status, relevance policy, cutoff, and dropped count",
      "warnings"
    ]);
  });

  it("keeps every tool metadata object valid and registration-ready", () => {
    for (const contract of SMEDC_MCP_TOOL_CONTRACTS) {
      expect(() => mcpToolContractSchema.parse(contract)).not.toThrow();
      expect(contract.resultShape.length).toBeGreaterThan(0);
      expect(Object.keys(contract.inputShape)).toEqual(
        contract.inputFields.map((field) => field.name)
      );
    }
  });

  it("accepts valid business inputs for all business tools", () => {
    for (const toolName of SMEDC_MCP_TOOL_NAMES) {
      expect(parseTool(toolName, validInputs[toolName])).toEqual(validInputs[toolName]);
    }
  });

  it("accepts the vip structured dataset in query and upload contracts", () => {
    const query = parseTool("query_structured_dataset", {
      ...validInputs.query_structured_dataset,
      dataset: "vip"
    }) as { dataset: string };
    const upload = parseTool("upload_structured_dataset", {
      ...validInputs.upload_structured_dataset,
      dataset: "vip"
    }) as { dataset: string };

    expect(query.dataset).toBe("vip");
    expect(upload.dataset).toBe("vip");
  });

  it.each(["delivery_ledger", "supplier_catalog"] as const)(
    "accepts the date-free %s dataset with CSV and XLSX upload inputs",
    (dataset) => {
      for (const file of [
        {
          name: `${dataset}.csv`,
          mediaType: "text/csv"
        },
        {
          name: `${dataset}.xlsx`,
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
      ]) {
        const input = {
          ...validInputs.upload_structured_dataset,
          file: {
            ...validInputs.upload_structured_dataset.file,
            ...file
          },
          dataset,
          startDate: undefined,
          endDate: undefined,
          snapshotDate: undefined
        };

        expect(parseTool("upload_structured_dataset", input)).toEqual(input);
        expect(
          parseTool("query_structured_dataset", {
            ...validInputs.query_structured_dataset,
            dataset
          })
        ).toMatchObject({ dataset });
      }

      for (const dateField of ["startDate", "endDate", "snapshotDate"] as const) {
        expect(
          safeParseTool("upload_structured_dataset", {
            ...validInputs.upload_structured_dataset,
            dataset,
            [dateField]: "20260829"
          }).success
        ).toBe(false);
      }
    }
  );

  it("lists all structured datasets in query and upload field descriptions", () => {
    const expectedDatasets = [
      "dishes",
      "business",
      "vip",
      "dish_catalog",
      "delivery_ledger",
      "supplier_catalog"
    ];

    for (const toolName of ["query_structured_dataset", "upload_structured_dataset"] as const) {
      const field = contractsByName
        .get(toolName)
        ?.inputFields.find((inputField) => inputField.name === "dataset");

      for (const dataset of expectedDatasets) {
        expect(field?.description).toContain(dataset);
      }
    }
  });

  it("defines strict coverage input with optional partition scope", () => {
    const coverage = contractsByName.get(
      "describe_structured_dataset_coverage" as SmedcMcpToolName
    );

    expect(coverage?.inputSchema.parse({ dataset: "business" })).toEqual({
      dataset: "business"
    });
    expect(Object.keys(coverage?.inputShape ?? {})).toEqual([
      "dataset",
      "enterpriseName",
      "storeNameContains"
    ]);
    expect(
      coverage?.inputFields.map((field) => ({ name: field.name, required: field.required }))
    ).toEqual([
      { name: "dataset", required: true },
      { name: "enterpriseName", required: false },
      { name: "storeNameContains", required: false }
    ]);
    expect(coverage?.description).toContain("/v1/structured/datasets/:dataset/coverage");
    expect(coverage?.resultShape).toEqual([
      "dataset",
      "metadataPolicy",
      "sources[]: readable applied source windows or snapshots",
      "cost_cards: accessMode: catalog_query, cardCount, totalItemRowCount, sources[]: { sourceDocumentId, importBatchId, cardCount, totalItemRowCount }"
    ]);
  });

  it("exposes the strict single-schema structured query contract", () => {
    const query = contractsByName.get("query_structured_dataset");

    expect(query?.inputFields.map((field) => field.name)).toContain("dataset");
    expect(query?.resultShape).toContain("dataset");
    expect(query?.resultShape).toContain(
      "presentation?: optional profile for delivery_ledger detail responses with id, title, and ordered columns[]"
    );
    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "business",
        unexpectedField: "not-allowed"
      }).success
    ).toBe(false);
  });

  it("keeps the structured upload schema object-shaped while enforcing conditional dates", () => {
    const contract = contractsByName.get("upload_structured_dataset");
    const catalogInput = {
      ...validInputs.upload_structured_dataset,
      dataset: "dish_catalog",
      snapshotDate: "20260819",
      startDate: undefined,
      endDate: undefined
    };

    expect(contract?.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(Object.keys(contract?.inputSchema.shape ?? {})).toEqual(
      expect.arrayContaining(["startDate", "endDate", "snapshotDate"])
    );
    expect(parseTool("upload_structured_dataset", catalogInput)).toMatchObject({
      dataset: "dish_catalog",
      snapshotDate: "20260819"
    });
    expect(
      parseTool("query_structured_dataset", {
        ...validInputs.query_structured_dataset,
        dataset: "dish_catalog"
      })
    ).toMatchObject({ dataset: "dish_catalog" });
    expect(
      safeParseTool("upload_structured_dataset", {
        ...catalogInput,
        snapshotDate: undefined
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...catalogInput,
        startDate: "20260819"
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        snapshotDate: "20260819"
      }).success
    ).toBe(false);
  });

  it("rejects table-driven invalid schema cases for every business tool", () => {
    expect(invalidInputCases.map((entry) => entry.tool)).toEqual(SMEDC_MCP_TOOL_NAMES);

    for (const { tool, cases } of invalidInputCases) {
      for (const testCase of cases) {
        expect(safeParseTool(tool, testCase.input).success, `${tool}: ${testCase.label}`).toBe(
          false
        );
      }
    }
  });

  it("rejects strict extra fields added to otherwise-valid inputs for every tool", () => {
    for (const toolName of SMEDC_MCP_TOOL_NAMES) {
      expect(safeParseTool(toolName, withTopLevelField(toolName, "extra", true)).success).toBe(
        false
      );
    }
  });

  it("rejects sessionName and filePath on otherwise-valid business tool payloads", () => {
    for (const toolName of SMEDC_MCP_TOOL_NAMES) {
      expect(
        safeParseTool(toolName, withTopLevelField(toolName, "sessionName", "local")).success
      ).toBe(false);
      expect(
        safeParseTool(toolName, withTopLevelField(toolName, "filePath", "/tmp/input.csv")).success
      ).toBe(false);

      const contract = contractsByName.get(toolName);
      expect(Object.keys(contract?.inputShape ?? {})).not.toContain("sessionName");
      expect(Object.keys(contract?.inputShape ?? {})).not.toContain("filePath");
    }
  });

  it("rejects path-like upload filenames", () => {
    for (const name of [
      "../sop.md",
      "nested/sop.md",
      "nested\\sop.md",
      "/tmp/sop.md",
      "C:sop.md",
      " sop.md",
      "sop.md "
    ]) {
      expect(
        safeParseTool("upload_evidence_document", {
          ...validInputs.upload_evidence_document,
          file: {
            ...validInputs.upload_evidence_document.file,
            name
          }
        }).success
      ).toBe(false);
    }
  });

  it("bounds static upload filename and media type attributes", () => {
    expect(MCP_UPLOAD_FILENAME_MAX_LENGTH).toBe(255);
    expect(MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH).toBe(255);

    const maxFilename = `${"a".repeat(MCP_UPLOAD_FILENAME_MAX_LENGTH - 4)}.csv`;
    const tooLongFilename = `${"a".repeat(MCP_UPLOAD_FILENAME_MAX_LENGTH - 3)}.csv`;
    const maxMediaType = `application/${"x".repeat(MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH - 12)}`;
    const tooLongMediaType = `application/${"x".repeat(MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH - 11)}`;

    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        file: { ...validInputs.upload_structured_dataset.file, name: maxFilename }
      }).success
    ).toBe(true);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        file: { ...validInputs.upload_structured_dataset.file, name: tooLongFilename }
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        file: { ...validInputs.upload_structured_dataset.file, mediaType: maxMediaType }
      }).success
    ).toBe(true);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        file: { ...validInputs.upload_structured_dataset.file, mediaType: tooLongMediaType }
      }).success
    ).toBe(false);
  });

  it("enforces shared metadata, search, cursor, and collection boundaries", () => {
    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        title: "t".repeat(512),
        sourceSystem: "s".repeat(255)
      }).success
    ).toBe(true);
    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        title: "t".repeat(513)
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        sourceSystem: "s".repeat(256)
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        confidentialityLevel: 4
      }).success
    ).toBe(false);

    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        enterpriseName: "e".repeat(255),
        idempotencyKey: "i".repeat(255)
      }).success
    ).toBe(true);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        enterpriseName: "e".repeat(256)
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        idempotencyKey: "i".repeat(256)
      }).success
    ).toBe(false);

    const acceptedFilterIds = Array.from({ length: 100 }, (_, index) => `doc_${index}`);
    expect(
      safeParseTool("search_document_evidence", {
        query: "q".repeat(4_000),
        cursor: "c".repeat(4_096),
        filters: {
          documentIds: acceptedFilterIds
        }
      }).success
    ).toBe(true);
    expect(
      safeParseTool("search_document_evidence", {
        query: "q".repeat(4_001)
      }).success
    ).toBe(false);
    expect(
      safeParseTool("search_document_evidence", {
        query: "q",
        cursor: "c".repeat(4_097)
      }).success
    ).toBe(false);
    expect(
      safeParseTool("search_document_evidence", {
        query: "q",
        filters: { documentIds: ["d".repeat(65)] }
      }).success
    ).toBe(false);
    expect(
      safeParseTool("search_document_evidence", {
        query: "q",
        filters: { documentIds: [...acceptedFilterIds, "doc_100"] }
      }).success
    ).toBe(false);
  });

  it("bounds structured query cursors and string scalar values", () => {
    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "dishes",
        page: { cursor: "c".repeat(4_096) },
        filter: {
          field: "matched_product_name",
          op: "contains",
          value: "v".repeat(32_767)
        }
      }).success
    ).toBe(true);
    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "dishes",
        page: { cursor: "c".repeat(4_097) }
      }).success
    ).toBe(false);
    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "dishes",
        filter: {
          field: "matched_product_name",
          op: "contains",
          value: "v".repeat(32_768)
        }
      }).success
    ).toBe(false);
  });

  it("rejects upload filename and media type control characters", () => {
    for (const name of ["bad\u0000name.csv", "bad\u001fname.csv", "bad\u007fname.csv"]) {
      expect(
        safeParseTool("upload_structured_dataset", {
          ...validInputs.upload_structured_dataset,
          file: { ...validInputs.upload_structured_dataset.file, name }
        }).success
      ).toBe(false);
    }

    for (const mediaType of ["text/\u0000csv", "text/csv\u001f", "text/csv\u007f"]) {
      expect(
        safeParseTool("upload_structured_dataset", {
          ...validInputs.upload_structured_dataset,
          file: { ...validInputs.upload_structured_dataset.file, mediaType }
        }).success
      ).toBe(false);
    }
  });

  it("requires strict MIME token syntax for upload media types", () => {
    for (const mediaType of [
      "text",
      "text/",
      "/csv",
      "text/ csv",
      "text/csv;charset",
      "text/csv; charset",
      "text/csv; charset=utf-8; bad",
      "text/csv; bad name=value"
    ]) {
      expect(
        safeParseTool("upload_structured_dataset", {
          ...validInputs.upload_structured_dataset,
          file: { ...validInputs.upload_structured_dataset.file, mediaType }
        }).success
      ).toBe(false);
    }

    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        file: {
          ...validInputs.upload_structured_dataset.file,
          mediaType: 'text/csv; charset=utf-8; header="present"'
        }
      }).success
    ).toBe(true);
  });

  it("mirrors structured query cardinality limits from the domain contract", () => {
    expect(MCP_STRUCTURED_QUERY_LIMITS).toBe(STRUCTURED_QUERY_LIMITS);
    expect(MCP_STRUCTURED_QUERY_LIMITS).toEqual({
      defaultLimit: 50,
      maxRows: 200,
      maxAggregateGroups: 200,
      maxBooleanDepth: 3,
      maxConditions: 20,
      maxInValues: 100,
      maxSortFields: 2,
      maxGroupByFields: 4,
      maxAggregates: 12,
      maxSelectedFields: 50,
      cursorTtlSeconds: 900
    });

    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "dishes",
        page: { limit: MCP_STRUCTURED_QUERY_LIMITS.maxRows }
      }).success
    ).toBe(true);
    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "dishes",
        aggregates: [{ op: "count", as: "rows" }],
        page: { limit: MCP_STRUCTURED_QUERY_LIMITS.maxAggregateGroups }
      }).success
    ).toBe(true);
    expect(
      safeParseTool("query_structured_dataset", {
        dataset: "business",
        groupBy: ["store_name", "order_source", "meal_period", "business_date"],
        aggregates: [
          ...Array.from({ length: MCP_STRUCTURED_QUERY_LIMITS.maxAggregates - 1 }, (_, index) => ({
            op: "sum" as const,
            field: "order_revenue",
            as: `revenue_${index}`
          })),
          {
            op: "weightedAvg",
            field: "discount_rate",
            weightField: "gross_sales_amount",
            as: "weighted_discount"
          }
        ],
        sort: [{ field: "weighted_discount", direction: "desc" }],
        page: { limit: MCP_STRUCTURED_QUERY_LIMITS.maxAggregateGroups }
      }).success
    ).toBe(true);
  });

  it("rejects non-canonical or whitespace-containing base64 upload content", () => {
    for (const contentBase64 of ["IyBT T1AK", "IyBTT1AK\n", "TQ=", "T", "not_base64!"]) {
      expect(
        safeParseTool("upload_structured_dataset", {
          ...validInputs.upload_structured_dataset,
          file: {
            ...validInputs.upload_structured_dataset.file,
            contentBase64
          }
        }).success
      ).toBe(false);
    }
  });

  it("exports MCP-facing JSON and error result helpers", () => {
    expect(jsonToolResult({ ok: true })).toEqual({
      content: [{ type: "text", text: '{\n  "ok": true\n}' }],
      isError: false
    });

    const validationError = parseErrorResult(
      errorToolResult("MCP_INPUT_VALIDATION_ERROR", "Invalid input.", { issue: "bad" })
    );
    expect(validationError).toEqual({
      error: {
        code: "MCP_INPUT_VALIDATION_ERROR",
        message: "Invalid input.",
        retryable: false,
        details: { issue: "bad" }
      }
    });
    expect(isMcpErrorBody(validationError)).toBe(true);
    expect(
      isMcpErrorBody({ error: { code: "MCP_INPUT_VALIDATION_ERROR", message: "Invalid input." } })
    ).toBe(false);
  });

  it("safely converts API errors with retryability and request ids", () => {
    expect(
      parseErrorResult(
        apiErrorToolResult({
          error: {
            code: "TRANSIENT_UPSTREAM_ERROR",
            message: "Temporary upstream failure.",
            retryable: true,
            requestId: "req_1",
            details: { sql: "select secret from private_table" }
          }
        })
      )
    ).toEqual({
      error: {
        code: "TRANSIENT_UPSTREAM_ERROR",
        message: "Temporary upstream failure.",
        retryable: true,
        requestId: "req_1"
      }
    });

    expect(parseErrorResult(apiErrorToolResult({ nope: true }))).toEqual({
      error: {
        code: "SMEDC_API_ERROR",
        message: "SMEDC API request failed.",
        retryable: true
      }
    });
  });

  it("assigns safe default retryability for API error conversions", () => {
    for (const code of [
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "AUTHORIZATION_FAILED",
      "DOCUMENT_NOT_FOUND",
      "IDEMPOTENCY_KEY_CONFLICT"
    ]) {
      expect(
        parseErrorResult(apiErrorToolResult({ error: { code, message: "API request failed." } }))
          .error.retryable
      ).toBe(false);
    }

    for (const code of ["INTERNAL_ERROR", "SERVICE_UNAVAILABLE", "TRANSIENT_UPSTREAM_ERROR"]) {
      expect(
        parseErrorResult(apiErrorToolResult({ error: { code, message: "API request failed." } }))
          .error.retryable
      ).toBe(true);
    }
  });

  it("forces known non-retryable API classes even when upstream says retryable", () => {
    for (const code of [
      "VALIDATION_FAILED",
      "BAD_REQUEST",
      "UNAUTHENTICATED",
      "AUTHORIZATION_FAILED",
      "DOCUMENT_NOT_FOUND",
      "DOCUMENT_NOTFOUND",
      "IDEMPOTENCY_KEY_CONFLICT",
      "ACTIVE_IMPORT_EXISTS",
      "IMPORT_IN_PROGRESS"
    ]) {
      expect(
        parseErrorResult(
          apiErrorToolResult({
            error: { code, message: "API request failed.", retryable: true }
          })
        ).error.retryable
      ).toBe(false);
    }
  });
});

function parseTool(name: SmedcMcpToolName, input: unknown): unknown {
  const contract = contractsByName.get(name);

  if (!contract) {
    throw new Error(`Missing contract for ${name}`);
  }

  return contract.inputSchema.parse(input);
}

function safeParseTool(name: SmedcMcpToolName, input: unknown): { success: boolean } {
  const contract = contractsByName.get(name);

  if (!contract) {
    throw new Error(`Missing contract for ${name}`);
  }

  return contract.inputSchema.safeParse(input);
}

function withTopLevelField(
  name: SmedcMcpToolName,
  fieldName: string,
  value: unknown
): Record<string, unknown> {
  return {
    ...cloneInput(validInputs[name]),
    [fieldName]: value
  };
}

function cloneInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function parseErrorResult(result: ReturnType<typeof errorToolResult>): {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId?: string;
    details?: unknown;
  };
} {
  expect(result.isError).toBe(true);
  const firstContent = result.content[0];

  if (!firstContent) {
    throw new Error("Expected MCP error result content.");
  }

  return JSON.parse(firstContent.text) as {
    error: {
      code: string;
      message: string;
      retryable: boolean;
      requestId?: string;
      details?: unknown;
    };
  };
}

describe("launcher path-mode upload schema", () => {
  const base64File = {
    name: "dishes.csv",
    mediaType: "text/csv",
    encoding: "base64",
    contentBase64: "YSwNCg=="
  };
  const pathFile = {
    name: "dishes.csv",
    mediaType: "text/csv",
    encoding: "path",
    filePath: "/tmp/dishes.csv"
  };

  it("accepts both base64 and absolute-path file variants", () => {
    expect(launcherUploadFileInputSchema.safeParse(base64File).success).toBe(true);
    expect(launcherUploadFileInputSchema.safeParse(pathFile).success).toBe(true);
  });

  it("rejects relative, empty, and over-length local file paths", () => {
    for (const filePath of ["dishes.csv", "../dishes.csv", "", "C:\\dishes.csv"]) {
      expect(launcherUploadFileInputSchema.safeParse({ ...pathFile, filePath }).success).toBe(
        false
      );
    }
    expect(
      launcherUploadFileInputSchema.safeParse({
        ...pathFile,
        filePath: `/${"a".repeat(MCP_LOCAL_FILE_PATH_MAX_LENGTH)}`
      }).success
    ).toBe(false);
  });

  it("keeps base64 and path variants mutually exclusive", () => {
    expect(
      launcherUploadFileInputSchema.safeParse({ ...base64File, filePath: "/tmp/dishes.csv" })
        .success
    ).toBe(false);
    expect(
      launcherUploadFileInputSchema.safeParse({ ...pathFile, contentBase64: "YSwNCg==" }).success
    ).toBe(false);
  });

  it("exposes a registration-ready shape with both encodings", () => {
    expect(Object.keys(launcherUploadFileInputShape).sort()).toEqual([
      "contentBase64",
      "encoding",
      "filePath",
      "mediaType",
      "name"
    ]);
    const shapeSchema = z.object(launcherUploadFileInputShape);
    expect(shapeSchema.safeParse(base64File).success).toBe(true);
    expect(shapeSchema.safeParse(pathFile).success).toBe(true);
  });

  it("exports the shared 50 MiB upload ceiling for launcher-side preflight", () => {
    expect(MCP_UPLOAD_MAX_BYTES).toBe(52_428_800);
  });

  it("keeps the server-facing schema base64-only and strict", () => {
    expect(
      safeParseTool("upload_structured_dataset", {
        ...validInputs.upload_structured_dataset,
        file: pathFile
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        file: pathFile
      }).success
    ).toBe(false);
  });
});

describe("ledger PDF contracts", () => {
  it("offers download tools without any employee PDF generation contract", () => {
    expect(SMEDC_MCP_TOOL_NAMES).not.toContain("refresh_ledger_pdfs");
    expect([...contractsByName.keys()]).not.toContain("refresh_ledger_pdfs");
  });
  const scopeTools = ["describe_ledger_pdf_coverage", "prepare_ledger_pdf_download"] as const;
  it.each(scopeTools)(
    "%s validates exclusive dates and public limits without guessing actual partitions",
    (name) => {
      const schema = contractsByName.get(name)?.inputSchema;
      expect(schema).toBeInstanceOf(z.ZodObject);
      const base = { storeNames: [" 门店名称 "], idempotencyKey: "scope-1" };
      if (name === "describe_ledger_pdf_coverage")
        delete (base as { idempotencyKey?: string }).idempotencyKey;
      expect(schema?.safeParse({ ...base, dates: ["2024-02-29"] }).success).toBe(true);
      expect(
        schema?.safeParse({
          ...base,
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          storeNames: Array.from({ length: 50 }, (_, i) => `门店${i}`)
        }).success
      ).toBe(true);
      for (const input of [
        { ...base, dates: ["2023-02-29"] },
        { ...base, dates: ["2026-04-31"] },
        { ...base, dates: ["2026-1-01"] },
        { ...base, dates: ["0000-01-01"] },
        { ...base, dates: [] },
        { ...base, dates: ["2026-01-01"], startDate: "2026-01-01", endDate: "2026-01-01" },
        { ...base, startDate: "2026-01-01" },
        { ...base, startDate: "2026-02-02", endDate: "2026-02-01" },
        { ...base, startDate: "2024-01-01", endDate: "2025-01-01" },
        {
          ...base,
          dates: ["2026-01-01"],
          storeNames: Array.from({ length: 51 }, (_, i) => `门店${i}`)
        },
        {
          ...base,
          dates: Array.from({ length: 367 }, (_, i) =>
            new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10)
          )
        },
        { ...base, dates: ["2026-01-01"], storeNames: ["   "] },
        { ...base, dates: ["2026-01-01"], force: true }
      ])
        expect(schema?.safeParse(input).success, JSON.stringify(input)).toBe(false);
      expect(z.toJSONSchema(schema!).additionalProperties).toBe(false);
    }
  );
  it("requires explicit stores and idempotency for ZIP preparation", () => {
    for (const name of ["prepare_ledger_pdf_download"] as const) {
      expect(safeParseTool(name, { dates: ["2026-01-01"], idempotencyKey: "key" }).success).toBe(
        false
      );
      expect(safeParseTool(name, { storeNames: ["店"], dates: ["2026-01-01"] }).success).toBe(
        false
      );
    }
  });
  it.each([
    ["LEDGER_PDF_NOT_ENABLED", false],
    ["LEDGER_DETAIL_DISABLED", false],
    ["LEDGER_PDF_NOT_READY", true],
    ["LEDGER_PDF_BUNDLE_STALE", false]
  ])("maps %s without internal error details", (code, retryable) => {
    expect(
      JSON.parse(
        apiErrorToolResult({
          error: {
            code,
            message: "Unavailable.",
            requestId: "req_pdf",
            details: { storageObjectKey: "private" }
          }
        }).content[0]!.text
      )
    ).toEqual({ error: { code, message: "Unavailable.", requestId: "req_pdf", retryable } });
  });
});

it.each(["download_structured_partitions", "describe_structured_dataset_coverage"] as const)(
  "validates and normalizes literal store-name scope for %s",
  (name) => {
    const schema = contractsByName.get(name)!.inputSchema;
    expect(
      schema.parse({
        ...validInputs[name],
        enterpriseName: "Synthetic",
        storeNameContains: [" 麦家小馆 ", "A%_\\"]
      })
    ).toMatchObject({ storeNameContains: ["麦家小馆", "A%_\\"] });
    expect(schema.safeParse({ ...validInputs[name], storeNameContains: [] }).success).toBe(false);
    expect(schema.safeParse({ ...validInputs[name], storeNameContains: [" "] }).success).toBe(
      false
    );
  }
);

it("registers prepare/status tools and accepts only mutually exclusive download selectors", () => {
  const byName = new Map<string, (typeof SMEDC_MCP_TOOL_CONTRACTS)[number]>(
    SMEDC_MCP_TOOL_CONTRACTS.map((tool) => [tool.name, tool])
  );
  expect(byName.has("prepare_structured_partition_download")).toBe(true);
  expect(byName.has("get_structured_partition_download_status")).toBe(true);
  const download = byName.get("download_structured_partitions")!.inputSchema;
  expect(download.safeParse({ requestId: "pd_1" }).success).toBe(true);
  expect(
    download.safeParse({ ...validInputs.download_structured_partitions, requestId: "pd_1" }).success
  ).toBe(false);
  expect(download.safeParse({ requestId: "pd_1", storeNameContains: ["A"] }).success).toBe(false);
});

describe("current business authorization contracts", () => {
  it("exposes server-controlled permission administration instead of arbitrary API or SQL dispatch", () => {
    const names = [
      "get_my_permissions",
      "list_account_permissions",
      "get_account_permissions",
      "update_account_permissions",
      "list_business_categories",
      "create_evidence_category",
      "update_business_category",
      "list_business_dimensions",
      "create_business_dimension",
      "update_business_dimension",
      "create_business_dimension_value",
      "update_business_dimension_value",
      "list_business_stores",
      "update_business_store",
      "update_evidence_document_attributes",
      "get_evidence_document_management_status",
      "prepare_authorization_cutover",
      "activate_authorization_cutover",
      "suspend_authorization_reads"
    ];
    expect(SMEDC_MCP_TOOL_NAMES).toEqual(expect.arrayContaining(names));
    for (const name of names) {
      const contract = SMEDC_MCP_TOOL_CONTRACTS.find((c) => String(c.name) === name)!;
      expect(
        contract.inputSchema.safeParse({ api: "/anything", sql: "SELECT *", orgId: "foreign" })
          .success
      ).toBe(false);
    }
  });
  it("requires explicit evidence business attributes and an exact single store for photos", () => {
    const evidence = contractsByName.get("upload_evidence_document")!;
    const complete = {
      ...validInputs.upload_evidence_document,
      categoryId: "memo",
      scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]
    };
    expect(evidence.inputSchema.safeParse(complete).success).toBe(true);
    expect(
      evidence.inputSchema.safeParse({ ...complete, confidentialityLevel: undefined }).success
    ).toBe(false);
    const photo = contractsByName.get("upload_quarantine_certificate")!;
    expect(
      photo.inputSchema.safeParse({
        ...validInputs.upload_quarantine_certificate,
        enterpriseName: "Enterprise",
        storeName: "Store A "
      }).success
    ).toBe(true);
    expect(
      photo.inputSchema.safeParse({
        ...validInputs.upload_quarantine_certificate,
        storeNames: ["A", "B"]
      }).success
    ).toBe(false);
  });
});

it("validates complete actual evidence dimension values and controlled fixed-category edits", () => {
  const evidence = contractsByName.get("upload_evidence_document")!.inputSchema;
  const scope = {
    enterpriseKey: "enterprise",
    ownership: "store",
    storeName: "Store A ",
    dimensions: { project: "X" }
  };
  expect(
    evidence.safeParse({ ...validInputs.upload_evidence_document, scopes: [scope] }).success
  ).toBe(true);
  expect(
    evidence.safeParse({
      ...validInputs.upload_evidence_document,
      scopes: [{ ...scope, dimensions: { project: ["X", "Y"] } }]
    }).success
  ).toBe(false);
  const category = contractsByName.get("update_business_category")!.inputSchema;
  expect(
    category.safeParse({
      ...validInputs.update_business_category,
      ownerships: ["store"],
      requiredDimensionIds: []
    }).success
  ).toBe(false);
  expect(
    category.safeParse({
      ...validInputs.update_business_category,
      confidentialityLevel: undefined,
      ownerships: ["group"],
      requiredDimensionIds: ["project"]
    }).success
  ).toBe(true);
});

it("defines cost-card selection and archive inputs without server detail selectors", () => {
  const tools = new Map<string, (typeof SMEDC_MCP_TOOL_CONTRACTS)[number]>(
    SMEDC_MCP_TOOL_CONTRACTS.map((tool) => [tool.name, tool])
  );
  const download = tools.get("download_cost_cards");
  expect(download).toBeDefined();
  const selection = {
    enterpriseName: "Synthetic",
    costCardIds: ["cc_a"],
    spuIds: ["spu"],
    skuIds: ["sku"],
    dishName: "菜",
    dishNameContains: "%_!",
    specificationName: "大份",
    baseCategoryName: "主食"
  };
  expect(download!.inputSchema.parse(selection)).toEqual(selection);
  for (const extra of [
    { startDate: "20261014" },
    { storeIds: ["store"] },
    { itemName: "盐" },
    { orgId: "other" }
  ])
    expect(download!.inputSchema.safeParse({ ...selection, ...extra }).success).toBe(false);
  expect(download!.inputSchema.safeParse({ costCardIds: [] }).success).toBe(false);
  expect(download!.inputSchema.safeParse({ skuIds: Array(101).fill("sku") }).success).toBe(false);
  const archive = tools.get("archive_cost_card")!;
  expect(archive.inputSchema.parse({ costCardId: "cc_a" })).toEqual({ costCardId: "cc_a" });
  expect(archive.inputSchema.safeParse({ costCardId: "../a" }).success).toBe(false);
  expect(archive.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true
  });
});

it("restricts cost-card MCP queries and coverage to directory fields", () => {
  const query = contractsByName.get("query_structured_dataset")!.inputSchema;
  expect(
    query.parse({
      dataset: "cost_cards",
      select: ["dish_name", "sale_price"],
      filter: { field: "sale_price", op: "gte", value: "12.000001" }
    })
  ).toMatchObject({ filter: { value: "12.000001" } });
  for (const invalid of [
    { filter: { field: "sale_price", op: "gte", value: 12 } },
    { select: ["item_name"] },
    { filter: { field: "recipe_name", op: "eq", value: "default" } },
    { aggregates: [{ op: "count" }] },
    { groupBy: ["dish_name"] }
  ])
    expect(query.safeParse({ dataset: "cost_cards", ...invalid }).success).toBe(false);
  const coverage = contractsByName.get("describe_structured_dataset_coverage")!.inputSchema;
  expect(coverage.safeParse({ dataset: "cost_cards", enterpriseName: "Synthetic" }).success).toBe(
    true
  );
  expect(coverage.safeParse({ dataset: "cost_cards", storeNameContains: ["Store"] }).success).toBe(
    false
  );
});

it("accepts complete original cost-card uploads without dates or classification overrides", () => {
  const upload = contractsByName.get("upload_structured_dataset")!.inputSchema;
  const input = {
    file: validInputs.upload_structured_dataset.file,
    dataset: "cost_cards",
    enterpriseName: "Synthetic",
    idempotencyKey: "cost"
  };
  expect(upload.parse(input)).toEqual(input);
  for (const extra of [
    { startDate: "20261014" },
    { snapshotDate: "20261014" },
    { confidentialityLevel: 1 }
  ])
    expect(upload.safeParse({ ...input, ...extra }).success).toBe(false);
});
