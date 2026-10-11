import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { legacyPermissionService } from "../business-authorization.test-support.js";
import { createReadOnlyMcpToolHandlers } from "../mcp/read-tools.js";
import { buildApiServer } from "../server.js";
const employee: AuthenticatedEmployee = {
  id: "emp",
  orgId: "org",
  organizationName: "Synthetic",
  displayName: "Synthetic",
  email: "synthetic@example.test",
  role: "admin",
  clearance: 3,
  disabled: false
};
describe("public ledger reads remain closed", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });
  function build(enabled: boolean) {
    const execute = vi.fn(async () => ({ rows: [], hasMore: false }));
    app = buildApiServer({
      runtimeEnv: { LEDGER_PDF_DELIVERY_ENABLED: String(enabled) },
      authenticateAccessToken: async () => employee,
      businessAuthorizationService: legacyPermissionService(employee),
      cursorSigningSecret: "secret",
      structuredQueryRepository: { execute },
      logger: false
    });
    return execute;
  }
  it.each([false, true])(
    "denies detail, aggregate and coverage with flag %s for HTTP and MCP",
    async (enabled) => {
      const execute = build(enabled);
      const headers = { authorization: "Bearer synthetic" };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/structured/query",
            payload: { dataset: "delivery_ledger" }
          })
        ).statusCode
      ).toBe(401);
      const audit = {
        requestId: "synthetic",
        sourceIp: "127.0.0.1",
        clientSource: "mcp_launcher" as const,
        launcherVersion: "0.5.0"
      };
      const handlers = createReadOnlyMcpToolHandlers({
        bearerToken: "synthetic",
        delegationProof: "synthetic",
        audit,
        inject: async (request) => {
          const response = await app.inject({
            ...request,
            payload: request.payload as import("light-my-request").InjectPayload
          });
          return { statusCode: response.statusCode, payload: response.payload };
        }
      });
      for (const query of [
        { dataset: "delivery_ledger", select: ["receipt_id"] },
        { dataset: "delivery_ledger", aggregates: [{ op: "count" }] }
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/structured/query",
          headers,
          payload: query
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe("LEDGER_DETAIL_DISABLED");
        const mcp = await handlers.query_structured_dataset!(query, { employee, audit });
        expect(mcp.isError).toBe(true);
        expect(JSON.parse(mcp.content[0]!.text!).error.code).toBe("LEDGER_DETAIL_DISABLED");
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/structured/datasets/delivery_ledger/coverage",
            headers
          })
        ).statusCode
      ).toBe(403);
      const registry = await app.inject({ method: "GET", url: "/v1/structured/datasets", headers });
      expect(
        registry
          .json()
          .datasets.some((entry: { dataset: string }) => entry.dataset === "delivery_ledger")
      ).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    }
  );
});
