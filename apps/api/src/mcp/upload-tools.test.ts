import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import { describe, expect, it, vi } from "vitest";
import {
  createUploadToolHandlers,
  type UploadApiDelegate,
  type UploadApiDelegationRequest
} from "./upload-tools.js";

const employee: AuthenticatedEmployee = {
  id: "emp_mcp_upload",
  orgId: "default-org",
  email: "mcp-upload@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "store:baoli"]
};

const mcpContext = {
  employee,
  requestId: "mcp_req_1",
  clientIp: "203.0.113.9"
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
      delegate,
      getDelegationContext: () => ({
        authorization: "Bearer secret-upload-token",
        requestId: "api_req_1",
        clientIp: "198.51.100.10",
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
    labelKeys: ["all_staff", "store:baoli"],
    ...overrides
  };
}

function validStructuredInput(overrides: Record<string, unknown> = {}) {
  return {
    file: inlineFile("maijia-dishes.csv", "text/csv", "col_a,col_b\none,two\n"),
    dataset: "dishes",
    enterpriseName: "Maijia",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "structured-upload-key",
    labelKeys: ["store:baoli"],
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
  it("exports a partial handler map for both upload tools", () => {
    const { handlers } = createHandlers({});

    expect(Object.keys(handlers).sort()).toEqual([
      "upload_evidence_document",
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
      "x-forwarded-for": "198.51.100.10"
    });

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
    expect(fields.get("labelKeys[]")?.map((value) => value.toString("utf8"))).toEqual([
      "all_staff",
      "store:baoli"
    ]);
  });

  it("maps valid structured uploads to the existing multipart structured import route", async () => {
    const csvBytes = Buffer.from("col_a,col_b\none,two\n", "utf8");
    const { handlers, requests } = createHandlers({});
    const result = await handlers.upload_structured_dataset?.(
      validStructuredInput({
        file: inlineFile("maijia-dishes.csv", "text/csv", csvBytes)
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
      filename: "maijia-dishes.csv",
      contentType: "text/csv"
    });
    expect(file?.body).toEqual(csvBytes);
    expect(textField(fields, "dataset")).toBe("dishes");
    expect(textField(fields, "enterpriseName")).toBe("Maijia");
    expect(textField(fields, "enterprise_name")).toBeUndefined();
    expect(textField(fields, "startDate")).toBe("20260701");
    expect(textField(fields, "endDate")).toBe("20260731");
    expect(textField(fields, "idempotencyKey")).toBe("structured-upload-key");
    expect(fields.get("labelKeys[]")?.map((value) => value.toString("utf8"))).toEqual([
      "store:baoli"
    ]);
  });

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
          labelKeys: ["all_staff"]
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
          labelKeys: ["all_staff", "store:baoli"]
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
          ...inlineFile("maijia-dishes.csv", "text/csv", "a,b\n"),
          filePath: "/tmp/maijia-dishes.csv"
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
            code: "UNKNOWN_LABEL",
            message: "One or more labels do not exist.",
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

    expect(serialized).toContain("ENTERPRISE_HUB_API_ERROR");
    expect(serialized).not.toContain("secret-upload-token");
    expect(serialized).not.toContain(sensitiveBase64);
    expect(serialized).not.toContain("sensitive uploaded data");
    expect(serialized).not.toContain("upstream exploded");
  });
});
