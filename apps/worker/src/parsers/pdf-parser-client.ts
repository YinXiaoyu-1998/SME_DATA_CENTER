import { createHash } from "node:crypto";
import { parsePdfEvidenceResult, type PdfEvidenceResult } from "@smedc/domain";

export interface PdfParserClient {
  parse(content: Buffer, options: { signal: AbortSignal }): Promise<PdfEvidenceResult>;
}
const safeCodes = new Set([
  "PDF_UNAUTHORIZED",
  "PDF_NOT_FOUND",
  "PDF_INVALID_REQUEST",
  "PDF_UNSUPPORTED_MEDIA_TYPE",
  "PDF_INPUT_TOO_LARGE",
  "PDF_INVALID_OR_ENCRYPTED",
  "PDF_BUSY",
  "PDF_UPLOAD_TIMEOUT",
  "PDF_TIMEOUT",
  "PDF_INVALID_RESULT",
  "PDF_OUTPUT_TOO_LARGE",
  "PDF_PAGE_LIMIT",
  "PDF_PIXEL_LIMIT",
  "PDF_INCOMPLETE_PARSE",
  "PDF_MODEL_MISSING",
  "PDF_MODEL_CHECKSUM_MISMATCH",
  "PDF_RUNTIME_VERSION_MISMATCH",
  "PDF_PARSE_FAILED"
]);
export class PdfParserRequestError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super("PDF parser request failed.");
    this.name = "PdfParserRequestError";
  }
}
export class HttpPdfParserClient implements PdfParserClient {
  private readonly url: string;
  constructor(
    private readonly input: {
      url: string;
      token: string;
      timeoutMs?: number;
      maxResponseBytes?: number;
      fetch?: typeof fetch;
    }
  ) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error("Invalid PDF parser configuration.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname) ||
      Buffer.byteLength(input.token) < 32 ||
      /[\r\n]/u.test(input.token)
    )
      throw new Error("Invalid PDF parser configuration.");
    this.url = url.origin;
  }
  async parse(content: Buffer, { signal }: { signal: AbortSignal }): Promise<PdfEvidenceResult> {
    if (content.length > 50 * 1024 * 1024)
      throw new PdfParserRequestError("PDF_INPUT_LIMIT", false);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), this.input.timeoutMs ?? 3_750_000);
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      combined.throwIfAborted();
      const ready = await this.request("/v1/ready", combined, undefined, 1024);
      if (
        !ready ||
        typeof ready !== "object" ||
        !("status" in ready) ||
        ready.status !== "ready" ||
        !("schemaVersion" in ready) ||
        ready.schemaVersion !== 1 ||
        !("parserFingerprint" in ready) ||
        typeof ready.parserFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(ready.parserFingerprint)
      )
        throw new PdfParserRequestError("PDF_NOT_READY", true);
      const value = await this.request(
        "/v1/parse",
        combined,
        content,
        this.input.maxResponseBytes ?? 16 * 1024 * 1024
      );
      const result = parsePdfEvidenceResult(value);
      if (result.sourceChecksumSha256 !== createHash("sha256").update(content).digest("hex"))
        throw new PdfParserRequestError("PDF_SOURCE_MISMATCH", false);
      if (result.parserFingerprint !== ready.parserFingerprint)
        throw new PdfParserRequestError("PDF_FINGERPRINT_MISMATCH", true);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw new DOMException("PDF processing cancelled.", "AbortError");
      if (deadline.signal.aborted) throw new PdfParserRequestError("PDF_TIMEOUT", true);
      if (
        error instanceof PdfParserRequestError ||
        (error instanceof Error && "code" in error && error.code === "PDF_INVALID_RESULT")
      )
        throw error;
      throw new PdfParserRequestError("PDF_SERVICE_UNAVAILABLE", true);
    } finally {
      clearTimeout(timeout);
    }
  }
  private async request(
    path: string,
    signal: AbortSignal,
    content: Buffer | undefined,
    maxBytes: number
  ): Promise<unknown> {
    const response = await (this.input.fetch ?? fetch)(`${this.url}${path}`, {
      method: content ? "POST" : "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.input.token}`,
        ...(content ? { "content-type": "application/pdf" } : {})
      },
      ...(content ? { body: new Uint8Array(content) } : {}),
      signal
    });
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new PdfParserRequestError("PDF_OUTPUT_LIMIT", false);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    try {
      if (reader)
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new PdfParserRequestError("PDF_OUTPUT_LIMIT", false);
          }
          chunks.push(part.value);
        }
    } finally {
      reader?.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new PdfParserRequestError("PDF_INVALID_RESULT", false);
    }
    if (!response.ok) {
      const code =
        value &&
        typeof value === "object" &&
        "code" in value &&
        typeof value.code === "string" &&
        safeCodes.has(value.code)
          ? value.code
          : "PDF_SERVICE_ERROR";
      throw new PdfParserRequestError(code, [408, 429, 500, 503, 504].includes(response.status));
    }
    return value;
  }
}
