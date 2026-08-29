import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STRUCTURED_QUERY_LIMITS } from "@enterprise-hub/domain";
import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  ENTERPRISE_HUB_MCP_TOOL_NAMES,
  MCP_LOCAL_FILE_PATH_MAX_LENGTH,
  MCP_STRUCTURED_QUERY_LIMITS,
  MCP_UPLOAD_FILENAME_MAX_LENGTH,
  MCP_UPLOAD_MAX_BYTES,
  MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH,
  apiErrorToolResult,
  errorToolResult,
  launcherUploadFileInputSchema,
  launcherUploadFileInputShape,
  type EnterpriseHubMcpToolName,
  isMcpErrorBody,
  jsonToolResult,
  mcpToolContractSchema
} from "./index.js";

const contractsByName = new Map(
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS.map((contract) => [contract.name, contract])
);

const validInputs = {
  enterprise_hub_list_labels: {},
  enterprise_hub_list_skills: { q: "menu", category: "menu-analysis" },
  search_document_evidence: {
    query: "refund SOP",
    filters: {
      fileTypes: ["md", "txt", "docx"],
      documentIds: ["doc_1"],
      labelIds: ["lbl_1"]
    },
    limit: 10,
    cursor: "cursor_1"
  },
  list_structured_datasets: {},
  query_structured_dataset: {
    dataset: "dishes",
    registryVersion: "dishes.2026-07-11.v1",
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
  upload_structured_dataset: {
    file: {
      name: "maijia-dishes.csv",
      mediaType: "text/csv",
      encoding: "base64",
      contentBase64: "Y29sMSxjb2wyCg=="
    },
    dataset: "business",
    enterpriseName: "Maijia",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "structured-retry-key",
    labelKeys: ["store:baoli"]
  },
  upload_evidence_document: {
    file: {
      name: "sop.md",
      mediaType: "text/markdown",
      encoding: "base64",
      contentBase64: "IyBTT1AK"
    },
    title: "SOP",
    sourceSystem: "manual",
    labelKeys: ["all_staff"]
  },
  get_evidence_document_status: { documentId: "doc_1" },
  get_import_status: { importBatchId: "imp_1" }
} satisfies Record<EnterpriseHubMcpToolName, Record<string, unknown>>;

const invalidInputCases = [
  {
    tool: "enterprise_hub_list_labels",
    cases: [{ label: "non-empty input", input: { unknown: true } }]
  },
  {
    tool: "enterprise_hub_list_skills",
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
        input: { query: "refund", filters: { labelIds: ["lbl_1"], extra: true } }
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
        input: { dataset: "dishes", groupBy: ["store_name", "city_name"] }
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
      }
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
        label: "empty label keys",
        input: { ...validInputs.upload_structured_dataset, labelKeys: [] }
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
      { label: "missing inline file", input: { title: "SOP", labelKeys: ["all_staff"] } },
      { label: "empty title", input: { ...validInputs.upload_evidence_document, title: "" } },
      {
        label: "empty label keys",
        input: { ...validInputs.upload_evidence_document, labelKeys: [] }
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
  }
] satisfies Array<{
  tool: EnterpriseHubMcpToolName;
  cases: Array<{ label: string; input: unknown }>;
}>;

describe("Enterprise Hub MCP contract", () => {
  it("exports the stable Phase 3 business tool names without local-session tools", () => {
    expect(ENTERPRISE_HUB_MCP_TOOL_NAMES).toEqual([
      "enterprise_hub_list_labels",
      "enterprise_hub_list_skills",
      "search_document_evidence",
      "list_structured_datasets",
      "query_structured_dataset",
      "upload_structured_dataset",
      "upload_evidence_document",
      "get_evidence_document_status",
      "get_import_status"
    ]);

    expect(ENTERPRISE_HUB_MCP_TOOL_NAMES).not.toContain("enterprise_hub_login_dev");
  });

  it("describes structured uploads as queued work and status as the async completion view", () => {
    const structuredUpload = ENTERPRISE_HUB_MCP_TOOL_CONTRACTS.find(
      (contract) => contract.name === "upload_structured_dataset"
    );
    const importStatus = ENTERPRISE_HUB_MCP_TOOL_CONTRACTS.find(
      (contract) => contract.name === "get_import_status"
    );

    expect(structuredUpload?.description).toContain("202");
    expect(structuredUpload?.description).toContain("queued");
    expect(importStatus?.description).toContain("terminal");
    expect(importStatus?.resultShape).toEqual(["document", "processing", "importBatch"]);
  });

  it("keeps every tool metadata object valid and registration-ready", () => {
    for (const contract of ENTERPRISE_HUB_MCP_TOOL_CONTRACTS) {
      expect(() => mcpToolContractSchema.parse(contract)).not.toThrow();
      expect(contract.resultShape.length).toBeGreaterThan(0);
      expect(Object.keys(contract.inputShape)).toEqual(
        contract.inputFields.map((field) => field.name)
      );
    }
  });

  it("accepts valid business inputs for all Phase 3 tools", () => {
    for (const toolName of ENTERPRISE_HUB_MCP_TOOL_NAMES) {
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

  it("rejects table-driven invalid schema cases for every Phase 3 tool", () => {
    expect(invalidInputCases.map((entry) => entry.tool)).toEqual(ENTERPRISE_HUB_MCP_TOOL_NAMES);

    for (const { tool, cases } of invalidInputCases) {
      for (const testCase of cases) {
        expect(safeParseTool(tool, testCase.input).success, `${tool}: ${testCase.label}`).toBe(
          false
        );
      }
    }
  });

  it("rejects strict extra fields added to otherwise-valid inputs for every tool", () => {
    for (const toolName of ENTERPRISE_HUB_MCP_TOOL_NAMES) {
      expect(safeParseTool(toolName, withTopLevelField(toolName, "extra", true)).success).toBe(
        false
      );
    }
  });

  it("rejects sessionName and filePath on otherwise-valid business tool payloads", () => {
    for (const toolName of ENTERPRISE_HUB_MCP_TOOL_NAMES) {
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
    const acceptedLabels = Array.from({ length: 50 }, (_, index) => `label_${index}`);

    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        title: "t".repeat(512),
        sourceSystem: "s".repeat(255),
        labelKeys: acceptedLabels
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
        labelKeys: ["l".repeat(129)]
      }).success
    ).toBe(false);
    expect(
      safeParseTool("upload_evidence_document", {
        ...validInputs.upload_evidence_document,
        labelKeys: [...acceptedLabels, "label_50"]
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
          documentIds: acceptedFilterIds,
          labelIds: ["l".repeat(64)]
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
      maxAggregateGroups: 100,
      maxBooleanDepth: 3,
      maxConditions: 20,
      maxInValues: 100,
      maxSortFields: 2,
      maxGroupByFields: 1,
      maxAggregates: 5,
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
        code: "ENTERPRISE_HUB_API_ERROR",
        message: "Enterprise Hub API request failed.",
        retryable: true
      }
    });
  });

  it("assigns safe default retryability for API error conversions", () => {
    for (const code of [
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "FORBIDDEN_LABEL",
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
      "FORBIDDEN_LABEL",
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

function parseTool(name: EnterpriseHubMcpToolName, input: unknown): unknown {
  const contract = contractsByName.get(name);

  if (!contract) {
    throw new Error(`Missing contract for ${name}`);
  }

  return contract.inputSchema.parse(input);
}

function safeParseTool(name: EnterpriseHubMcpToolName, input: unknown): { success: boolean } {
  const contract = contractsByName.get(name);

  if (!contract) {
    throw new Error(`Missing contract for ${name}`);
  }

  return contract.inputSchema.safeParse(input);
}

function withTopLevelField(
  name: EnterpriseHubMcpToolName,
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
