import type { AuthenticatedEmployee } from "@smedc/domain";
import { SMEDC_MCP_TOOL_CONTRACTS } from "@smedc/mcp-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createUploadToolHandlers,
  type UploadApiDelegate,
  type UploadToolHandlerOptions,
  type UploadApiDelegationRequest
} from "./upload-tools.js";

const employee: AuthenticatedEmployee = {
  id: "emp_mcp_upload",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "MCP Upload Employee",
  email: "mcp-upload@example.com",
  role: "admin",
  disabled: false,
  clearance: 3
};

const delegationProof = Buffer.alloc(32, 0x5a).toString("base64url");
const mcpAudit = Object.freeze({
  requestId: "mcp_req_1",
  sourceIp: "203.0.113.9",
  clientSource: "mcp_launcher" as const,
  launcherVersion: "0.1.0"
});

const mcpContext = {
  employee,
  audit: mcpAudit
};

function createHandlers(input: {
  maxUploadBytes?: number;
  delegate?: UploadApiDelegate;
  requests?: UploadApiDelegationRequest[];
}) {
  const requests = input.requests ?? [];
  const delegate: UploadApiDelegate =
    input.delegate ??
    (async (request) => {
      requests.push(request);

      return {
        statusCode: 202,
        payload: JSON.stringify({
          ok: true,
          requestPath: request.url
        })
      };
    });

  return {
    requests,
    handlers: createUploadToolHandlers({
      authorizeUpload: async () => true,
      delegate,
      getDelegationContext: () => ({
        authorization: "Bearer secret-upload-token",
        audit: Object.freeze({
          ...mcpAudit,
          requestId: "api_req_1",
          sourceIp: "198.51.100.10"
        }),
        delegationProof,
        maxUploadBytes: input.maxUploadBytes ?? 1024
      })
    })
  };
}

function validEvidenceInput(overrides: Record<string, unknown> = {}) {
  return {
    file: inlineFile("customer-feedback-sop.md", "text/markdown", "# SOP\nhandle feedback\n"),
    title: "Customer feedback SOP",
    sourceSystem: "manual",
    confidentialityLevel: 0,
    ...overrides
  };
}

function validStructuredInput(overrides: Record<string, unknown> = {}) {
  return {
    file: inlineFile("synthetic-vip.csv", "text/csv", "col_a,col_b\none,two\n"),
    dataset: "vip",
    enterpriseName: "Synthetic",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "structured-upload-key",
    confidentialityLevel: 0,
    ...overrides
  };
}

function validQuarantineInput(overrides: Record<string, unknown> = {}) {
  return {
    file: inlineFile(
      "quarantine.png",
      "image/png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
    receiptId: "SH2608250117",
    idempotencyKey: "quarantine-upload-key",
    confidentialityLevel: 0,
    ...overrides
  };
}

function inlineFile(name: string, mediaType: string, content: string | Buffer) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");

  return {
    name,
    mediaType,
    encoding: "base64",
    contentBase64: body.toString("base64")
  };
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

function parseMultipart(request: UploadApiDelegationRequest) {
  const contentType = request.headers["content-type"];
  const boundary = contentType?.match(/boundary=([^;]+)/)?.[1];

  if (!boundary) {
    throw new Error("Missing multipart boundary.");
  }

  const raw = request.payload.toString("binary");
  const parts = raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.replace(/^\r\n/, "").replace(/\r\n$/, ""));

  return parts.map((part) => {
    const [rawHeaders = "", rawBody = ""] = part.split("\r\n\r\n");
    const headers = Object.fromEntries(
      rawHeaders.split("\r\n").map((line) => {
        const separator = line.indexOf(":");

        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()] as const;
      })
    );
    const disposition = headers["content-disposition"] ?? "";
    const name = disposition.match(/name="((?:\\"|[^"])*)"/)?.[1]?.replace(/\\"/g, '"');
    const filename = disposition.match(/filename="((?:\\"|[^"])*)"/)?.[1]?.replace(/\\"/g, '"');

    return {
      name,
      filename,
      contentType: headers["content-type"],
      body: Buffer.from(rawBody, "binary")
    };
  });
}

function multipartFields(request: UploadApiDelegationRequest) {
  const fields = new Map<string, Buffer[]>();

  for (const part of parseMultipart(request)) {
    if (!part.name) {
      continue;
    }

    fields.set(part.name, [...(fields.get(part.name) ?? []), part.body]);
  }

  return fields;
}

function textField(fields: Map<string, Buffer[]>, name: string) {
  return fields.get(name)?.[0]?.toString("utf8");
}

describe("upload MCP tool handlers", () => {
  it.each([
    ["upload_evidence_document", "evidence_document"],
    ["upload_quarantine_certificate", "quarantine_certificate"],
    ["upload_structured_dataset", "structured_dataset"]
  ] as const)("denies %s before any input, abort, or upload work", async (toolName, surface) => {
    const authorizeUpload = vi.fn<UploadToolHandlerOptions["authorizeUpload"]>(async () => false);
    const delegate = vi.fn<UploadApiDelegate>();
    const getDelegationContext = vi.fn();
    const handlers = createUploadToolHandlers({ authorizeUpload, delegate, getDelegationContext });
    const context = { ...mcpContext, employee: { ...employee, role: "employee" as const } };
    const abortRead = vi.fn(() => {
      throw new Error("abort accessed before authorization");
    });
    Object.defineProperty(context, "abortSignal", { get: abortRead });
    const inspectInput = vi.fn(() => {
      throw new Error("input accessed before authorization");
    });
    const input = new Proxy({}, { get: inspectInput, has: inspectInput, ownKeys: inspectInput });
    const contract = SMEDC_MCP_TOOL_CONTRACTS.find((tool) => tool.name === toolName)!;
    const parse = vi.spyOn(contract.inputSchema, "safeParse");
    const decode = vi.spyOn(Buffer, "from");
    const assemble = vi.spyOn(Buffer, "concat");
    try {
      const result = await handlers[toolName]!(input, context);
      expect(result.isError).toBe(true);
      expect(parseResult(result)).toEqual({
        error: {
          code: "UPLOAD_ADMIN_REQUIRED",
          message: "File upload requires the admin role.",
          retryable: false,
          requestId: "mcp_req_1"
        }
      });
      expect(authorizeUpload).toHaveBeenCalledOnce();
      expect(authorizeUpload.mock.calls[0]?.[0]).toBe(context);
      expect(authorizeUpload.mock.calls[0]?.[1]).toBe(surface);
      for (const operation of [
        abortRead,
        inspectInput,
        getDelegationContext,
        parse,
        decode,
        assemble,
        delegate
      ]) {
        expect(operation).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([{}, { dataset: "private-fake-dataset" }, { dataset: "delivery_ledger" }])(
    "classifies every denied structured request without inspecting its dataset: %j",
    async (input) => {
      const authorizeUpload = vi.fn(async () => false);
      const delegate = vi.fn<UploadApiDelegate>();
      const handlers = createUploadToolHandlers({
        authorizeUpload,
        delegate,
        getDelegationContext: vi.fn()
      });
      const context = { ...mcpContext, employee: { ...employee, role: "employee" as const } };
      const result = await handlers.upload_structured_dataset!(input, context);
      expect(parseResult(result)).toMatchObject({
        error: { code: "UPLOAD_ADMIN_REQUIRED", retryable: false, requestId: "mcp_req_1" }
      });
      expect(authorizeUpload).toHaveBeenCalledExactlyOnceWith(context, "structured_dataset");
      expect(JSON.stringify(result)).not.toContain("private-fake-dataset");
      expect(delegate).not.toHaveBeenCalled();
    }
  );
  it("exports a partial handler map for both upload tools", () => {
    const { handlers } = createHandlers({});

    expect(Object.keys(handlers).sort()).toEqual([
      "upload_evidence_document",
      "upload_quarantine_certificate",
      "upload_structured_dataset"
    ]);
  });

  it("maps valid evidence uploads to the existing multipart evidence route", async () => {
    const { handlers, requests } = createHandlers({});
    const result = await handlers.upload_evidence_document?.(validEvidenceInput(), mcpContext);

    expect(parseResult(result!)).toEqual({
      ok: true,
      requestPath: "/v1/documents/evidence"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/documents/evidence",
      remoteAddress: "198.51.100.10"
    });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer secret-upload-token",
      "x-request-id": "api_req_1",
      "x-smedc-internal-delegation": delegationProof,
      "x-smedc-launcher-version": "0.1.0"
    });
    expect(requests[0]?.headers).not.toHaveProperty("x-forwarded-for");
    expect(requests[0]?.headers).not.toHaveProperty("x-real-ip");

    const parts = parseMultipart(requests[0]!);
    const file = parts.find((part) => part.name === "file");
    const fields = multipartFields(requests[0]!);

    expect(file).toMatchObject({
      filename: "customer-feedback-sop.md",
      contentType: "text/markdown"
    });
    expect(file?.body.toString("utf8")).toBe("# SOP\nhandle feedback\n");
    expect(textField(fields, "title")).toBe("Customer feedback SOP");
    expect(textField(fields, "sourceSystem")).toBe("manual");
    expect(textField(fields, "confidentialityLevel")).toBe("0");
  });

  it("maps valid structured uploads to the existing multipart structured import route", async () => {
    const csvBytes = Buffer.from("col_a,col_b\none,two\n", "utf8");
    const { handlers, requests } = createHandlers({});
    const result = await handlers.upload_structured_dataset?.(
      validStructuredInput({
        file: inlineFile("synthetic-vip.csv", "text/csv", csvBytes)
      }),
      mcpContext
    );

    expect(parseResult(result!)).toEqual({
      ok: true,
      requestPath: "/v1/structured/imports"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/structured/imports"
    });

    const parts = parseMultipart(requests[0]!);
    const file = parts.find((part) => part.name === "file");
    const fields = multipartFields(requests[0]!);

    expect(file).toMatchObject({
      filename: "synthetic-vip.csv",
      contentType: "text/csv"
    });
    expect(file?.body).toEqual(csvBytes);
    expect(textField(fields, "dataset")).toBe("vip");
    expect(textField(fields, "enterpriseName")).toBe("Synthetic");
    expect(textField(fields, "enterprise_name")).toBeUndefined();
    expect(textField(fields, "startDate")).toBe("20260701");
    expect(textField(fields, "endDate")).toBe("20260731");
    expect(textField(fields, "idempotencyKey")).toBe("structured-upload-key");
    expect(textField(fields, "confidentialityLevel")).toBe("0");
  });

  it("requires launcher 0.5.0 before a business or dishes upload can reach the legacy proxy", async () => {
    const { handlers, requests } = createHandlers({});

    const result = await handlers.upload_structured_dataset?.(
      validStructuredInput({ dataset: "dishes" }),
      mcpContext
    );

    expect(requests).toEqual([]);
    expect(result?.isError).toBe(true);
    expect(parseResult(result!)).toMatchObject({
      error: { code: "LAUNCHER_UPGRADE_REQUIRED", requestId: "mcp_req_1" }
    });
  });

  it("maps quarantine certificate uploads to the dedicated multipart route", async () => {
    const { handlers, requests } = createHandlers({});
    const result = await handlers.upload_quarantine_certificate?.(
      validQuarantineInput(),
      mcpContext
    );

    expect(parseResult(result!)).toEqual({
      ok: true,
      requestPath: "/v1/documents/quarantine-certificates"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/documents/quarantine-certificates"
    });

    const parts = parseMultipart(requests[0]!);
    const file = parts.find((part) => part.name === "file");
    const fields = multipartFields(requests[0]!);

    expect(file).toMatchObject({
      filename: "quarantine.png",
      contentType: "image/png"
    });
    expect(textField(fields, "receiptId")).toBe("SH2608250117");
    expect(textField(fields, "idempotencyKey")).toBe("quarantine-upload-key");
    expect(textField(fields, "confidentialityLevel")).toBe("0");
  });

  it("maps a catalog snapshot to multipart snapshotDate without window fields", async () => {
    const { handlers, requests } = createHandlers({});
    const result = await handlers.upload_structured_dataset?.(
      validStructuredInput({
        dataset: "dish_catalog",
        snapshotDate: "20260819",
        startDate: undefined,
        endDate: undefined
      }),
      mcpContext
    );

    expect(parseResult(result!)).toEqual({
      ok: true,
      requestPath: "/v1/structured/imports"
    });
    expect(requests).toHaveLength(1);
    const fields = multipartFields(requests[0]!);
    expect(textField(fields, "snapshotDate")).toBe("20260819");
    expect(textField(fields, "startDate")).toBeUndefined();
    expect(textField(fields, "endDate")).toBeUndefined();
  });

  it.each([
    ["delivery_ledger", "delivery-ledger.csv", "text/csv"],
    [
      "supplier_catalog",
      "supplier-catalog.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ]
  ] as const)(
    "maps %s uploads to multipart without any date fields",
    async (dataset, filename, mediaType) => {
      const content = Buffer.from(`${dataset},synthetic\n`, "utf8");
      const { handlers, requests } = createHandlers({});
      const result = await handlers.upload_structured_dataset?.(
        validStructuredInput({
          file: inlineFile(filename, mediaType, content),
          dataset,
          startDate: undefined,
          endDate: undefined,
          snapshotDate: undefined,
          enterpriseName: "Supplier and Delivery Smoke",
          idempotencyKey: `${dataset}-upload-key`,
          confidentialityLevel: 0
        }),
        mcpContext
      );

      expect(parseResult(result!)).toEqual({
        ok: true,
        requestPath: "/v1/structured/imports"
      });
      expect(requests).toHaveLength(1);
      const parts = parseMultipart(requests[0]!);
      const file = parts.find((part) => part.name === "file");
      const fields = multipartFields(requests[0]!);

      expect(file).toMatchObject({ filename, contentType: mediaType });
      expect(file?.body).toEqual(content);
      expect(textField(fields, "dataset")).toBe(dataset);
      expect(textField(fields, "enterpriseName")).toBe("Supplier and Delivery Smoke");
      expect(textField(fields, "idempotencyKey")).toBe(`${dataset}-upload-key`);
      expect(textField(fields, "confidentialityLevel")).toBe("0");
      expect(textField(fields, "startDate")).toBeUndefined();
      expect(textField(fields, "endDate")).toBeUndefined();
      expect(textField(fields, "snapshotDate")).toBeUndefined();
    }
  );

  it("rejects malformed base64 before decoding or delegating", async () => {
    const requests: UploadApiDelegationRequest[] = [];
    const malformedBase64 = "not canonical base64";
    const { handlers } = createHandlers({ requests });
    const result = await handlers.upload_evidence_document?.(
      validEvidenceInput({
        file: {
          name: "sop.md",
          mediaType: "text/markdown",
          encoding: "base64",
          contentBase64: malformedBase64
        }
      }),
      mcpContext
    );
    const serialized = JSON.stringify(parseResult(result!));

    expect(requests).toHaveLength(0);
    expect(JSON.parse(serialized)).toMatchObject({
      error: {
        code: "MCP_INPUT_VALIDATION_ERROR",
        retryable: false
      }
    });
    expect(serialized).not.toContain(malformedBase64);
  });

  it("rejects decoded uploads over the context-provided maximum", async () => {
    const requests: UploadApiDelegationRequest[] = [];
    const oversizedContent = "# SOP\nhandle feedback\n";
    const oversizedBase64 = Buffer.from(oversizedContent, "utf8").toString("base64");
    const { handlers } = createHandlers({ requests, maxUploadBytes: 4 });
    const result = await handlers.upload_evidence_document?.(
      validEvidenceInput({
        file: {
          name: "customer-feedback-sop.md",
          mediaType: "text/markdown",
          encoding: "base64",
          contentBase64: oversizedBase64
        }
      }),
      mcpContext
    );
    const serialized = JSON.stringify(parseResult(result!));

    expect(requests).toHaveLength(0);
    expect(JSON.parse(serialized)).toMatchObject({
      error: {
        code: "MCP_INLINE_FILE_TOO_LARGE",
        message: "Upload file is too large.",
        retryable: false,
        requestId: "api_req_1"
      }
    });
    expect(serialized).not.toContain(oversizedBase64);
    expect(serialized).not.toContain(oversizedContent);
  });

  it("rejects oversized encoded uploads before Buffer decode or delegation", async () => {
    const oversizedBase64 = "A".repeat(8);
    const requests: UploadApiDelegationRequest[] = [];
    const { handlers } = createHandlers({ requests, maxUploadBytes: 3 });
    const bufferFrom = vi.spyOn(Buffer, "from").mockImplementation(() => {
      throw new Error("Buffer.from should not be called for encoded-size rejection.");
    });

    try {
      const result = await handlers.upload_evidence_document?.(
        {
          file: {
            name: "oversized.md",
            mediaType: "text/markdown",
            encoding: "base64",
            contentBase64: oversizedBase64
          },
          title: "Oversized evidence",
          sourceSystem: "manual",
          confidentialityLevel: 0
        },
        mcpContext
      );
      const serialized = JSON.stringify(parseResult(result!));

      expect(requests).toHaveLength(0);
      expect(JSON.parse(serialized)).toMatchObject({
        error: {
          code: "MCP_INLINE_FILE_TOO_LARGE",
          message: "Upload file is too large.",
          retryable: false,
          requestId: "api_req_1"
        }
      });
      expect(serialized).not.toContain(oversizedBase64);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it("honors already-aborted contexts before upload decode, multipart assembly, or delegation", async () => {
    const controller = new AbortController();
    controller.abort();
    const getDelegationContext = vi.fn();
    const delegate = vi.fn<UploadApiDelegate>();
    const handlers = createUploadToolHandlers({
      authorizeUpload: async () => true,
      delegate,
      getDelegationContext
    });
    const bufferFrom = vi.spyOn(Buffer, "from").mockImplementation(() => {
      throw new Error("Buffer.from should not be called for already-aborted uploads.");
    });

    try {
      const result = await handlers.upload_evidence_document?.(
        {
          file: {
            name: "customer-feedback-sop.md",
            mediaType: "text/markdown",
            encoding: "base64",
            contentBase64: "IyBTT1AK"
          },
          title: "Customer feedback SOP",
          sourceSystem: "manual",
          confidentialityLevel: 0
        },
        {
          ...mcpContext,
          abortSignal: controller.signal
        }
      );
      const serialized = JSON.stringify(result);

      expect(getDelegationContext).not.toHaveBeenCalled();
      expect(delegate).not.toHaveBeenCalled();
      expect(result?.isError).toBe(true);
      expect(parseResult(result!)).toEqual({
        error: {
          code: "MCP_REQUEST_CANCELLED",
          message: "MCP request was cancelled before upload processing started.",
          retryable: false,
          requestId: "mcp_req_1"
        }
      });
      expect(serialized).not.toContain("secret-upload-token");
      expect(serialized).not.toContain("# SOP");
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it("rejects filePath input without touching the delegate", async () => {
    const requests: UploadApiDelegationRequest[] = [];
    const { handlers } = createHandlers({ requests });
    const result = await handlers.upload_structured_dataset?.(
      validStructuredInput({
        file: {
          ...inlineFile("synthetic-dishes.csv", "text/csv", "a,b\n"),
          filePath: "/tmp/synthetic-dishes.csv"
        }
      }),
      mcpContext
    );

    expect(requests).toHaveLength(0);
    expect(JSON.stringify(parseResult(result!))).toContain("MCP_INPUT_VALIDATION_ERROR");
  });

  it("converts backend authorization and validation errors through MCP error results", async () => {
    const backendErrors = [
      {
        statusCode: 401,
        payload: {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication is required.",
            requestId: "api_auth_req"
          }
        }
      },
      {
        statusCode: 400,
        payload: {
          error: {
            code: "VALIDATION_FAILED",
            message: "The request is invalid.",
            requestId: "api_validation_req"
          }
        }
      }
    ];

    for (const backendError of backendErrors) {
      const { handlers } = createHandlers({
        delegate: async () => ({
          statusCode: backendError.statusCode,
          payload: JSON.stringify(backendError.payload)
        })
      });

      const result = await handlers.upload_evidence_document?.(validEvidenceInput(), mcpContext);

      expect(parseResult(result!)).toMatchObject({
        error: {
          code: backendError.payload.error.code,
          message: backendError.payload.error.message,
          retryable: false,
          requestId: backendError.payload.error.requestId
        }
      });
    }
  });

  it("does not leak bearer tokens or base64 file content in adapter error results", async () => {
    const sensitiveBase64 = Buffer.from("sensitive uploaded data", "utf8").toString("base64");
    const { handlers } = createHandlers({
      delegate: async () => ({
        statusCode: 500,
        payload: "upstream exploded"
      })
    });
    const result = await handlers.upload_evidence_document?.(
      validEvidenceInput({
        file: {
          name: "sensitive.md",
          mediaType: "text/markdown",
          encoding: "base64",
          contentBase64: sensitiveBase64
        }
      }),
      mcpContext
    );
    const serialized = JSON.stringify(parseResult(result!));

    expect(serialized).toContain("SMEDC_API_ERROR");
    expect(serialized).not.toContain("secret-upload-token");
    expect(serialized).not.toContain(sensitiveBase64);
    expect(serialized).not.toContain("sensitive uploaded data");
    expect(serialized).not.toContain("upstream exploded");
  });
});
