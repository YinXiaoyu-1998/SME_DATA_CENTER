import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApiServer } from "./server.js";
import Fastify from "fastify";
import { csrfTokenForSecret } from "./auth/http-contract.js";
import { BROWSER_SESSION_COOKIE, type BrowserSessions } from "./auth/browser-session.js";
import { createEmployeeDirectoryService } from "./employee-directory/service.js";
import { registerEmployeeDirectoryWebRoutes } from "./employee-directory/routes.js";

describe.skipIf(process.env["RUN_DIRECTORY_INTEGRATION"] !== "1")(
  "employee directory public lifecycle",
  () => {
    const suffix = randomUUID().slice(0, 8),
      orgId = `dir_${suffix}`,
      userId = `usr_${suffix}`;
    const actor = {
      id: userId,
      orgId,
      email: `${suffix}@example.invalid`,
      displayName: "Admin",
      organizationName: "Synthetic",
      role: "admin" as const,
      disabled: false,
      clearance: 3
    };
    const enterpriseKey = "synthetic";
    let prisma: PrismaClient;
    let app: ReturnType<typeof buildApiServer>;
    const call = (action: string, body: object) =>
      app.inject({
        method: "POST",
        url: `/v1/directory/${action}`,
        headers: { authorization: "Bearer synthetic" },
        payload: { enterpriseKey, ...body }
      });
    beforeAll(async () => {
      prisma = new PrismaClient({ adapter: createDatabaseAdapter(process.env["DATABASE_URL"]!) });
      await prisma.organization.create({ data: { id: orgId, name: "Synthetic" } });
      await prisma.userAccount.create({
        data: {
          id: userId,
          orgId,
          email: actor.email,
          displayName: actor.displayName,
          role: "admin",
          clearance: 3
        }
      });
      await prisma.businessAuthorizationState.create({ data: { orgId, mode: "enabled" } });
      await prisma.businessEnterpriseIdentity.create({
        data: { orgId, enterpriseKey, enterpriseName: "Synthetic" }
      });
      await prisma.businessCategory.create({
        data: {
          orgId,
          id: "profile",
          key: "employee_profiles",
          name: "员工档案",
          kind: "fixed",
          confidentialityLevel: 1,
          allowGroup: true,
          allowStore: true
        }
      });
      app = buildApiServer({
        logger: false,
        runtimeEnv: { ...process.env, DATABASE_URL: process.env["DATABASE_URL"] },
        cursorSigningSecret: "synthetic-secret",
        authenticateAccessToken: async () => actor
      });
    });
    afterAll(async () => {
      await app?.close();
      await prisma?.employee.deleteMany({ where: { orgId } });
      await prisma?.auditLog.deleteMany({ where: { orgId } });
      await prisma?.businessGrant.deleteMany({ where: { orgId } });
      await prisma?.businessDepartment.deleteMany({ where: { orgId } });
      await prisma?.businessStore.deleteMany({ where: { orgId } });
      await prisma?.businessCategory.deleteMany({ where: { orgId } });
      await prisma?.businessAuthorizationState.deleteMany({ where: { orgId } });
      await prisma?.businessEnterpriseIdentity.deleteMany({ where: { orgId } });
      await prisma?.userAccount.deleteMany({ where: { orgId } });
      await prisma?.organization.deleteMany({ where: { id: orgId } });
      await prisma?.$disconnect();
    });
    it("creates without read access, enforces grants and preserves identity through departure", async () => {
      const store = (
        await call("manage_store", { operation: { kind: "create", name: "门店甲" } })
      ).json();
      const department = (
        await call("manage_department", { operation: { kind: "create", name: "前厅" } })
      ).json();
      const created = await call("create_employee", {
        name: "小王",
        departmentId: department.departmentId,
        scope: { ownership: "store", storeId: store.storeId }
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(Object.keys(created.json())).toEqual(["employeeUid"]);
      const employeeUid = created.json().employeeUid;
      const hidden = await call("list_employees", {});
      expect(hidden.json()).toMatchObject({ access: "none", employees: [] });
      expect((await call("get_employee", { employeeUid })).statusCode).toBe(404);
      await prisma.businessGrant.create({
        data: {
          orgId,
          id: "grant",
          userAccountId: userId,
          enterpriseKey,
          ownership: "store",
          allStores: true
        }
      });
      await prisma.businessGrantCategory.create({
        data: { orgId, grantId: "grant", categoryId: "profile" }
      });
      const web = Fastify();
      registerEmployeeDirectoryWebRoutes(web, {
        browserSessions: { authenticate: async () => actor } as unknown as BrowserSessions,
        webOrigin: "https://app.example.invalid",
        directory: () => createEmployeeDirectoryService(prisma)
      });
      try {
        const secret = "synthetic-browser-secret";
        const webResult = await web.inject({
          method: "POST",
          url: `/api/web/v1/orgs/${orgId}/directory/get_employee`,
          headers: {
            origin: "https://app.example.invalid",
            cookie: `${BROWSER_SESSION_COOKIE}=${secret}`,
            "x-csrf-token": csrfTokenForSecret(secret)
          },
          payload: { enterpriseKey, employeeUid }
        });
        expect(webResult.statusCode, webResult.body).toBe(200);
        expect(webResult.json().employee).toMatchObject({ employeeUid, name: "小王" });
      } finally {
        await web.close();
      }
      const mcp = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: {
          host: "127.0.0.1:3000",
          authorization: "Bearer synthetic",
          accept: "application/json, text/event-stream",
          "x-smedc-launcher-version": "0.18.0"
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "query_employee_directory",
            arguments: { request: { action: "get_employee", enterpriseKey, employeeUid } }
          }
        }
      });
      expect(mcp.statusCode, mcp.body).toBe(200);
      const mcpResult = mcp.json().result;
      expect(mcpResult.isError, JSON.stringify(mcpResult)).not.toBe(true);
      expect(JSON.parse(mcpResult.content[0].text)).toMatchObject({
        employee: { employeeUid, name: "小王" }
      });
      const visible = await call("get_employee", { employeeUid });
      expect(visible.statusCode, visible.body).toBe(200);
      expect(visible.json().employee).toMatchObject({
        employeeUid,
        name: "小王",
        departmentName: "前厅",
        scope: { storeName: "门店甲" },
        status: "active",
        version: "0"
      });
      expect(
        (
          await call("manage_store", {
            operation: { kind: "retire", storeId: store.storeId, expectedVersion: "0" }
          })
        ).statusCode
      ).toBe(409);
      const departed = await call("update_employee", {
        employeeUid,
        expectedVersion: "0",
        name: "小王",
        departmentId: department.departmentId,
        scope: { ownership: "store", storeId: store.storeId },
        status: "departed"
      });
      expect(departed.statusCode, departed.body).toBe(200);
      expect(
        (
          await call("manage_store", {
            operation: { kind: "retire", storeId: store.storeId, expectedVersion: "0" }
          })
        ).statusCode
      ).toBe(200);
      expect((await call("list_employees", {})).json().employees).toEqual([]);
      expect((await call("get_employee", { employeeUid })).json().employee).toMatchObject({
        employeeUid,
        status: "departed",
        scope: { storeName: "门店甲" }
      });
    });
  }
);
