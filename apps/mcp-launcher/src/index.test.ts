import { PassThrough } from "node:stream";
import { upsertStoreReviewsInputSchema, SMEDC_MCP_TOOL_CONTRACTS } from "@smedc/mcp-contract";
import { createLauncherStdioTransport } from "./server.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LAUNCHER_VERSION } from "./oauth-client.js";
import { MCP_LAUNCHER_SERVER_VERSION } from "./server.js";
import { COST_CARD_LAUNCHER_VERSION } from "@smedc/mcp-contract";

describe("launcher CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the runtime launcher version for --version", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousArgv = process.argv;
    process.argv = ["node", "index.js", "--version"];
    try {
      const { runCommand } = await import("./index.js");
      await runCommand();
    } finally {
      process.argv = previousArgv;
    }
    expect(write).toHaveBeenCalledWith(`${LAUNCHER_VERSION}\n`);
  });

  it("keeps the package, protocol server, and runtime release on 0.13.0", () => {
    expect(LAUNCHER_VERSION).toBe("0.13.0");
    expect(MCP_LAUNCHER_SERVER_VERSION).toBe(LAUNCHER_VERSION);
    expect(COST_CARD_LAUNCHER_VERSION).toBe("0.10.0");
    expect(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
    ).toBe(LAUNCHER_VERSION);
  });
});

it("accepts a legal review batch larger than the SDK default stdio buffer", async () => {
  const input = {
    reviews: Array.from({ length: 240 }, (_, index) => ({
      enterpriseName: "合成企业",
      source: "美团评价",
      storeName: "合成门店",
      reviewerName: `用户${index}`,
      reviewedAt: "2026-10-17 13",
      content: "中".repeat(16_384)
    }))
  };
  expect(upsertStoreReviewsInputSchema.safeParse(input).success).toBe(true);
  const bytes = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "upsert_store_reviews", arguments: input }
    }) + "\n"
  );
  expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024);
  const stdin = new PassThrough();
  const transport = createLauncherStdioTransport(stdin, new PassThrough());
  const received = vi.fn();
  const failed = vi.fn();
  transport.onmessage = received;
  transport.onerror = failed;
  await transport.start();
  try {
    stdin.write(bytes);
    expect(failed).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0]![0].params.arguments.reviews).toHaveLength(240);
    expect(
      SMEDC_MCP_TOOL_CONTRACTS.find(
        (tool) => tool.name === "upsert_store_reviews"
      )!.inputSchema.safeParse(received.mock.calls[0]![0].params.arguments).success
    ).toBe(true);
  } finally {
    await transport.close();
  }
});
