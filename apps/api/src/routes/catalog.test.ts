import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApiServer } from "../server.js";
import {
  accessTokenFor,
  adminEmployee,
  authenticateTestAccessToken,
  createRepository,
  createSkillRepository,
  skillEntries,
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

  it("finds both brand names only for whole-brand queries among approved category matches", async () => {
    const [weekly, menu, disabled] = skillEntries;
    const entries = [
      { ...weekly!, id: "legacy", description: "SMEDC weekly reports" },
      { ...weekly!, id: "localized", description: "企业智脑周报" },
      { ...menu!, description: "企业智脑菜单" },
      { ...disabled!, category: "reporting", description: "SMEDC" }
    ];
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      authenticateAccessToken: authenticateTestAccessToken,
      skillRepository: createSkillRepository(entries),
      cursorSigningSecret: jwtSecret,
      logger: false
    });
    const headers = { authorization: `Bearer ${await accessTokenFor(adminEmployee)}` };
    const ids = async (q: string) => {
      const result = await app!.inject({
        method: "GET",
        url: "/skills",
        query: { q, category: "reporting" },
        headers
      });
      expect(result.statusCode).toBe(200);
      return result.json<{ skills: { id: string }[] }>().skills.map((skill) => skill.id);
    };
    for (const q of ["企业智脑", "SMEDC", "smedc"]) {
      expect(await ids(q)).toEqual(["legacy", "localized"]);
    }
    expect(await ids("SMEDC weekly")).toEqual(["legacy"]);
    expect(await ids("企业智")).toEqual(["localized"]);
  });
});
