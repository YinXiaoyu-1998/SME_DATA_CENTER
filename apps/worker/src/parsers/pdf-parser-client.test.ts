import { createHash } from "node:crypto";
import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { HttpPdfParserClient } from "./pdf-parser-client.js";

const content = Buffer.from("%PDF-synthetic");
const fingerprint = "a".repeat(64);
const result = () => ({
  schemaVersion: 1,
  sourceChecksumSha256: createHash("sha256").update(content).digest("hex"),
  parserFingerprint: fingerprint,
  pageCount: 1,
  pages: [{ pageNumber: 1, outcome: "parsed" }],
  blocks: [
    {
      blockId: "b1",
      blockType: "paragraph",
      text: "synthetic text",
      headingPath: [],
      sourceLocation: { pageNumber: 1, method: "native" },
      metadata: {}
    }
  ],
  tables: [],
  pictures: [],
  warnings: []
});
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});
async function client(
  handler: RequestListener,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {}
) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return new HttpPdfParserClient({
    url: `http://127.0.0.1:${address.port}`,
    token: "t".repeat(32),
    ...options
  });
}
function ready(response: import("node:http").ServerResponse) {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ status: "ready", schemaVersion: 1, parserFingerprint: fingerprint })
  );
}
describe("internal PDF parser client", () => {
  it("authenticates readiness and sends only raw PDF bytes then validates the result", async () => {
    let bytes = Buffer.alloc(0);
    const paths: string[] = [];
    const parser = await client((request, response) => {
      paths.push(request.url!);
      expect(request.headers.authorization).toBe(`Bearer ${"t".repeat(32)}`);
      if (request.url === "/v1/ready") return ready(response);
      expect(request.headers["content-type"]).toBe("application/pdf");
      request.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
      });
      request.on("end", () => response.end(JSON.stringify(result())));
    });
    expect(await parser.parse(content, { signal: new AbortController().signal })).toEqual(result());
    expect(bytes).toEqual(content);
    expect(paths).toEqual(["/v1/ready", "/v1/parse"]);
  });
  it("does not follow a redirect or leak the token/error body", async () => {
    let redirected = false;
    const parser = await client((request, response) => {
      if (request.url === "/leak") redirected = true;
      response.writeHead(302, { location: "/leak" });
      response.end("secret private path");
    });
    await expect(parser.parse(content, { signal: new AbortController().signal })).rejects.toThrow(
      "PDF parser request failed."
    );
    expect(redirected).toBe(false);
  });
  it("bounds streamed responses before JSON parsing", async () => {
    const parser = await client(
      (request, response) =>
        request.url === "/v1/ready" ? ready(response) : response.end("x".repeat(2048)),
      { maxResponseBytes: 1024 }
    );
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "PDF_OUTPUT_LIMIT", retryable: false });
  });
  it("rejects SHA and readiness fingerprint mismatch", async () => {
    const parser = await client((request, response) =>
      request.url === "/v1/ready"
        ? ready(response)
        : response.end(JSON.stringify({ ...result(), sourceChecksumSha256: "b".repeat(64) }))
    );
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "PDF_SOURCE_MISMATCH" });
  });
  it("rejects incomplete page accounting", async () => {
    const parser = await client((request, response) =>
      request.url === "/v1/ready"
        ? ready(response)
        : response.end(JSON.stringify({ ...result(), pageCount: 2 }))
    );
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "PDF_INVALID_RESULT" });
  });
  it("cancels an in-flight request and enforces a total deadline", async () => {
    const parser = await client(() => {}, { timeoutMs: 30 });
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "PDF_TIMEOUT", retryable: true });
    const controller = new AbortController();
    const pending = parser.parse(content, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("keeps long PDF header and body waits scoped to its own transport", async () => {
    const original = getGlobalDispatcher();
    const shortGlobal = new Agent({ headersTimeout: 25, bodyTimeout: 25 });
    setGlobalDispatcher(shortGlobal);
    try {
      let parseCalls = 0;
      const parser = await client(
        (request, response) => {
          if (request.url === "/v1/ready") return ready(response);
          parseCalls += 1;
          if (parseCalls === 1) setTimeout(() => response.end(JSON.stringify(result())), 100);
          else {
            response.writeHead(200, { "content-type": "application/json" });
            response.flushHeaders();
            setTimeout(() => response.end(JSON.stringify(result())), 100);
          }
        },
        { timeoutMs: 1_000 }
      );
      expect(await parser.parse(content, { signal: new AbortController().signal })).toEqual(
        result()
      );
      expect(await parser.parse(content, { signal: new AbortController().signal })).toEqual(
        result()
      );
      expect(getGlobalDispatcher()).toBe(shortGlobal);
    } finally {
      setGlobalDispatcher(original);
      await shortGlobal.destroy();
    }
  });
  it("rejects unsafe endpoint configuration", () => {
    for (const url of [
      "http://user:pass@127.0.0.1",
      "http://127.0.0.1?token=secret",
      "http://127.0.0.1/other",
      "file:///tmp/a"
    ])
      expect(() => new HttpPdfParserClient({ url, token: "t".repeat(32) })).toThrow(
        "Invalid PDF parser configuration."
      );
  });
  it("preserves the service's fixed busy/incomplete codes without echoing messages", async () => {
    let status = 503;
    let code = "PDF_BUSY";
    const parser = await client((request, response) => {
      if (request.url === "/v1/ready") return ready(response);
      response.writeHead(status);
      response.end(JSON.stringify({ code, message: "private unsafe body" }));
    });
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({
      code: "PDF_BUSY",
      retryable: true,
      message: "PDF parser request failed."
    });
    status = 422;
    code = "PDF_INCOMPLETE_PARSE";
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "PDF_INCOMPLETE_PARSE", retryable: false });
  });
  it("rejects a different fingerprint than authenticated readiness", async () => {
    const parser = await client((request, response) =>
      request.url === "/v1/ready"
        ? ready(response)
        : response.end(JSON.stringify({ ...result(), parserFingerprint: "b".repeat(64) }))
    );
    await expect(
      parser.parse(content, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "PDF_FINGERPRINT_MISMATCH" });
  });
  it("cancels a PDF request that has already reached the internal service", async () => {
    let reached: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const parser = await client((request, response) => {
      if (request.url === "/v1/ready") return ready(response);
      reached();
    });
    const controller = new AbortController();
    const pending = parser.parse(content, { signal: controller.signal });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
