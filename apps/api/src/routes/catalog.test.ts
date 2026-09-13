import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApiServer } from "../server.js";
import {
  adminEmployee,
  authenticateTestAccessToken,
  createRepository,
  jwtSecret
} from "../test-support/api-server-fixtures.js";

describe("catalog routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("keeps the skill catalog authenticated and removes label and public audit routes", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const unauthorized = await app.inject({ method: "GET", url: "/skills" });
    const labels = await app.inject({ method: "GET", url: "/labels" });
    const audit = await app.inject({ method: "GET", url: "/audit" });

    expect(unauthorized.statusCode).toBe(401);
    expect(labels.statusCode).toBe(404);
    expect(audit.statusCode).toBe(404);
  });
});
