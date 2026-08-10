import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApiServer } from "../server.js";
import {
  adminEmployee,
  baoliManagerEmployee,
  accessTokenFor,
  authenticateTestAccessToken,
  createDocumentRepository,
  createRepository,
  createSkillRepository,
  jwtSecret,
  skillEntries
} from "../test-support/api-server-fixtures.js";

describe("catalog routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function buildCatalogTestServer() {
    const documentRepository = createDocumentRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee, baoliManagerEmployee]),
      documentRepository,
      skillRepository: createSkillRepository(skillEntries),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    return { app, documentRepository };
  }

  it("requires authentication before listing labels", async () => {
    const { app } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/labels"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("lists the authenticated label catalog without granting assignment rights", async () => {
    const { app } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/labels",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      labels: [
        { key: "all_staff", name: "All Staff", type: "all_staff" },
        { key: "person:admin", name: "Admin Personal", type: "personal" },
        {
          key: "person:baoli.manager",
          name: "Baoli Manager Personal",
          type: "personal"
        },
        { key: "person:lijie", name: "Li Jie Personal", type: "personal" },
        { key: "person:suzhou.manager", name: "Suzhou Manager Personal", type: "personal" },
        { key: "store:baoli", name: "Baoli Store", type: "store" },
        { key: "store:suzhou", name: "Suzhou Store", type: "store" }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain("label_");
  });

  it("requires admin role before listing audit events", async () => {
    const { app, documentRepository } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/audit",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "FORBIDDEN", message: "Admin access is required." }
    });
    expect(documentRepository.auditLogs).toHaveLength(0);
  });

  it("lists audit events with bounded cursor pagination and nullable provenance", async () => {
    const { app, documentRepository } = buildCatalogTestServer();
    documentRepository.auditLogs.push(
      {
        id: "audit_1",
        action: "document.uploaded",
        actorEmployeeId: adminEmployee.id,
        targetType: "document",
        targetId: "doc_1",
        result: "succeeded",
        metadata: { documentKind: "evidence" },
        requestId: "req_1",
        clientIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null,
        createdAt: new Date("2026-07-18T00:00:00.000Z")
      },
      {
        id: "audit_2",
        action: "document.archived",
        actorEmployeeId: null,
        targetType: "document",
        targetId: "doc_2",
        result: "succeeded",
        metadata: null,
        requestId: undefined,
        clientIp: undefined,
        clientSource: null,
        launcherVersion: null,
        createdAt: new Date("2026-07-19T00:00:00.000Z")
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/audit?limit=1",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });
    const nextResponse = await app.inject({
      method: "GET",
      url: `/audit?limit=1&cursor=${response.json().nextCursor}`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      auditEvents: [
        {
          id: "audit_2",
          actorEmployeeId: null,
          action: "document.archived",
          targetType: "document",
          targetId: "doc_2",
          result: "succeeded",
          metadata: null,
          requestId: null,
          clientIp: null,
          clientSource: null,
          launcherVersion: null,
          createdAt: "2026-07-19T00:00:00.000Z"
        }
      ],
      nextCursor: "1"
    });
    expect(nextResponse.statusCode).toBe(200);
    expect(nextResponse.json().auditEvents[0]).toMatchObject({
      id: "audit_1",
      requestId: "req_1",
      clientSource: "http_api"
    });
  });

  it("rejects an over-limit audit cursor before repository access", async () => {
    const { app, documentRepository } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: `/audit?cursor=${"1".repeat(4_097)}`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_AUDIT_QUERY" }
    });
    expect(documentRepository.auditLogs).toHaveLength(0);
  });

  it("rejects invalid audit limits before repository access", async () => {
    const { app, documentRepository } = buildCatalogTestServer();
    const headers = {
      authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
    };

    for (const limit of ["0", "51", "not-a-number"]) {
      const response = await app.inject({
        method: "GET",
        url: `/audit?limit=${limit}`,
        headers
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_AUDIT_QUERY" }
      });
    }
    expect(documentRepository.auditLogs).toHaveLength(0);
  });

  it("requires authentication before listing skills", async () => {
    const { app } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/skills"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("returns the menu analysis skill for a Chinese q filter without executing it", async () => {
    const { app } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/skills?q=%E8%8F%9C%E5%8D%95",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      skills: [
        {
          id: "skill_menu_gross_margin_analysis",
          name: "menu-gross-margin-analysis",
          description: "菜单毛利分析 skill，帮助员工智能体分析菜品毛利和菜单结构。",
          version: "1.0.0",
          category: "menu-analysis",
          inputRequirements: ["已授权的菜单数据", "菜品成本数据", "销售明细"],
          installInstructions:
            "Install the approved menu-gross-margin-analysis skill in the employee agent.",
          examplePrompts: ["分析最近三个月菜单毛利，找出需要调整的菜品"],
          status: "approved"
        }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain("executionResult");
    expect(JSON.stringify(response.json())).not.toContain("Disabled internal experiment");
  });

  it("filters approved skills by category", async () => {
    const { app } = buildCatalogTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/skills?category=reporting",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills.map((skill: { name: string }) => skill.name)).toEqual([
      "weekly-store-report"
    ]);
    expect(JSON.stringify(response.json())).not.toContain("disabled-skill");
  });
});
