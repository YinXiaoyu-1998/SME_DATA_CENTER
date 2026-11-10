import { describe, expect, it } from "vitest";
import { buildTestServer } from "./test-support/api-server-fixtures.js";

describe("employee directory HTTP", () => {
  it("requires authentication before disclosing an enterprise directory", async () => {
    const app = buildTestServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/directory/list_directory",
        payload: { enterpriseKey: "business-a" }
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
