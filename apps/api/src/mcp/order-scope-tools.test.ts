import { expect, it } from "vitest";
import { createOrderScopeMcpToolHandlers } from "./order-scope-tools.js";
import type { McpRequestContext } from "./tool-handlers.js";
it("prepares the exact current scope through the authenticated partition endpoint", async () => {
  const audit = {
    requestId: "req-scope",
    sourceIp: "127.0.0.1",
    clientSource: "mcp_launcher" as const,
    launcherVersion: "0.16.0"
  };
  const handlers = createOrderScopeMcpToolHandlers({
    bearerToken: "synthetic-token",
    audit,
    delegationProof: "synthetic-proof",
    inject: async (request) => {
      expect(request.url).toBe("/v1/structured/order-scope-transitions");
      expect(request.headers.authorization).toBe("Bearer synthetic-token");
      return {
        statusCode: 201,
        payload: JSON.stringify({
          previewId: "osc_1",
          confirmationDigest: "b".repeat(64),
          partitions: []
        })
      };
    }
  });
  const input = {
    enterpriseName: "Synthetic",
    startDate: "2026-10-26",
    endDate: "2026-10-27",
    storeNames: ["Store A"],
    orderScope: "settled_only",
    sourceChecksumSha256: "a".repeat(64)
  };
  const result = await handlers.prepare_order_scope_transition!(input, {
    audit
  } as unknown as McpRequestContext);
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ previewId: "osc_1" });
  expect(
    (
      await handlers.prepare_order_scope_transition!({ ...input, orgId: "other" }, {
        audit
      } as unknown as McpRequestContext)
    ).isError
  ).toBe(true);
});
