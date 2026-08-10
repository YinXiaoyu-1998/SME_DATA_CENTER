import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import type { DocumentCatalogRepository } from "../documents.js";
import type { SkillDirectoryRepository } from "../skills.js";
import { createRequestAuth } from "../request-auth.js";
import { registerCatalogRoutes } from "./catalog.js";
import type { ApiServerContext } from "../app-context.js";

const manager: AuthenticatedEmployee = {
  id: "emp_manager",
  orgId: "default-org",
  email: "manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff"]
};

const admin: AuthenticatedEmployee = {
  ...manager,
  id: "emp_admin",
  email: "admin@example.com",
  role: "admin"
};

function context(input: {
  documents: DocumentCatalogRepository;
  skills: SkillDirectoryRepository;
}): ApiServerContext {
  return {
    environment: {},
    delegationProof: "proof",
    runtimeLimits: {} as ApiServerContext["runtimeLimits"],
    cursorSigningSecret: "secret",
    readinessCheck: async () => ({ ok: true, checks: [] }) as never,
    authCore: undefined,
    authenticateOfficialAccessToken: async (token) =>
      token === "admin" ? admin : token === "manager" ? manager : null,
    authenticationClientSource: () => "http_api",
    createBusinessRequestAudit: () => {
      throw new Error("not used");
    },
    documents: () => input.documents,
    storage: () => {
      throw new Error("not used");
    },
    structuredImports: () => {
      throw new Error("not used");
    },
    structuredQueries: () => {
      throw new Error("not used");
    },
    skills: () => input.skills,
    evidence: () => {
      throw new Error("not used");
    },
    close: async () => undefined
  };
}

function repositories() {
  const documents = {
    async listLabels() {
      return [{ id: "label_1", key: "all_staff", name: "All Staff", type: "all_staff" }];
    },
    async listAuditLogs() {
      return {
        auditLogs: [
          {
            id: "audit_1",
            actorEmployeeId: "emp_admin",
            action: "document.uploaded",
            targetType: "document",
            targetId: "doc_1",
            result: "success",
            metadata: null,
            requestId: "req_1",
            clientIp: "198.51.100.10",
            clientSource: "http_api",
            launcherVersion: null,
            createdAt: new Date("2026-08-10T00:00:00.000Z")
          }
        ],
        nextCursor: null
      };
    }
  } as unknown as DocumentCatalogRepository;

  const skills = {
    async listApprovedSkills(input) {
      expect(input).toEqual({
        orgId: "default-org",
        q: "report",
        category: "ops"
      });
      return [
        {
          id: "skill_1",
          name: "ops-report",
          description: "Builds an ops report.",
          version: "1.0.0",
          category: "ops",
          inputRequirements: ["authorized evidence"],
          installInstructions: "Install it.",
          examplePrompts: ["write the report"],
          status: "approved"
        }
      ];
    }
  } as SkillDirectoryRepository;

  return { documents, skills };
}

describe("catalog routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("lists label and skill catalog responses without exposing internal label IDs", async () => {
    const dependencies = context(repositories());
    app = Fastify({ logger: false });
    registerCatalogRoutes(app, {
      auth: createRequestAuth(dependencies),
      documents: dependencies.documents,
      skills: dependencies.skills
    });

    const labels = await app.inject({
      method: "GET",
      url: "/labels",
      headers: { authorization: "Bearer manager" }
    });
    const skills = await app.inject({
      method: "GET",
      url: "/skills?q=report&category=ops",
      headers: { authorization: "Bearer manager" }
    });

    expect(labels.statusCode).toBe(200);
    expect(labels.json()).toEqual({
      labels: [{ key: "all_staff", name: "All Staff", type: "all_staff" }]
    });
    expect(JSON.stringify(labels.json())).not.toContain("label_1");
    expect(skills.statusCode).toBe(200);
    expect(skills.json()).toMatchObject({
      skills: [{ id: "skill_1", name: "ops-report" }]
    });
  });

  it("keeps audit admin-only and cursor validation behavior", async () => {
    const dependencies = context(repositories());
    app = Fastify({ logger: false });
    registerCatalogRoutes(app, {
      auth: createRequestAuth(dependencies),
      documents: dependencies.documents,
      skills: dependencies.skills
    });

    const managerAudit = await app.inject({
      method: "GET",
      url: "/audit",
      headers: { authorization: "Bearer manager" }
    });
    const invalidCursor = await app.inject({
      method: "GET",
      url: `/audit?cursor=${"1".repeat(4_097)}`,
      headers: { authorization: "Bearer admin" }
    });
    const adminAudit = await app.inject({
      method: "GET",
      url: "/audit",
      headers: { authorization: "Bearer admin" }
    });

    expect(managerAudit.statusCode).toBe(403);
    expect(managerAudit.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Admin access is required." }
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toEqual({
      error: {
        code: "INVALID_AUDIT_QUERY",
        message: "Audit query pagination is invalid."
      }
    });
    expect(adminAudit.statusCode).toBe(200);
    expect(adminAudit.json()).toMatchObject({
      auditEvents: [
        {
          id: "audit_1",
          requestId: "req_1",
          launcherVersion: null,
          createdAt: "2026-08-10T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });
  });
});
