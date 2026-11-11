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
    const otherEnterpriseKey = "synthetic-other";
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
      await prisma.businessEnterpriseIdentity.create({
        data: { orgId, enterpriseKey: otherEnterpriseKey, enterpriseName: "Synthetic Other" }
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
      const otherDepartment = (
        await call("manage_department", { operation: { kind: "create", name: "后厨" } })
      ).json();
      const invalidDeparture = await call("update_employee", {
        employeeUid,
        expectedVersion: "0",
        name: "小王",
        departmentId: otherDepartment.departmentId,
        scope: { ownership: "store", storeId: store.storeId },
        status: "departed"
      });
      expect(invalidDeparture.statusCode, invalidDeparture.body).toBe(409);
      expect((await call("get_employee", { employeeUid })).json().employee).toMatchObject({
        departmentId: department.departmentId,
        status: "active",
        version: "0"
      });
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
      const rewriteDeparted = await call("update_employee", {
        employeeUid,
        expectedVersion: "1",
        name: "小王",
        departmentId: otherDepartment.departmentId,
        scope: { ownership: "store", storeId: store.storeId },
        status: "departed"
      });
      expect(rewriteDeparted.statusCode).toBe(409);
      const renameDeparted = await call("update_employee", {
        employeeUid,
        expectedVersion: "1",
        name: "小王更正",
        departmentId: department.departmentId,
        scope: { ownership: "store", storeId: store.storeId },
        status: "departed"
      });
      expect(renameDeparted.statusCode, renameDeparted.body).toBe(200);
      expect((await call("list_employees", {})).json().employees).toEqual([]);
      expect((await call("get_employee", { employeeUid })).json().employee).toMatchObject({
        employeeUid,
        status: "departed",
        scope: { storeName: "门店甲" }
      });
    });

    it("prechecks department names with the same database comparison as writes", async () => {
      const created = await call("manage_department", {
        operation: { kind: "create", name: "Ａ组" }
      });
      expect(created.statusCode, created.body).toBe(200);
      const departmentId = created.json().departmentId;
      expect(
        (
          await call("manage_department", {
            operation: { kind: "retire", departmentId, expectedVersion: "0" }
          })
        ).statusCode
      ).toBe(200);

      const web = Fastify();
      const employeeId = `employee_${suffix}`;
      await prisma.userAccount.create({
        data: {
          orgId,
          id: employeeId,
          email: `employee-${actor.email}`,
          displayName: "Synthetic employee",
          role: "employee",
          clearance: 3
        }
      });
      let principal: typeof actor | null = actor;
      registerEmployeeDirectoryWebRoutes(web, {
        browserSessions: {
          authenticate: async () => principal
        } as unknown as BrowserSessions,
        webOrigin: "https://app.example.invalid",
        directory: () => createEmployeeDirectoryService(prisma)
      });
      const check = (payload: object, requestOrgId = orgId) =>
        web.inject({
          method: "POST",
          url: `/api/web/v1/orgs/${requestOrgId}/directory/check_department_name`,
          headers: {
            origin: "https://app.example.invalid",
            cookie: `${BROWSER_SESSION_COOKIE}=synthetic-browser-secret`,
            "x-csrf-token": csrfTokenForSecret("synthetic-browser-secret")
          },
          payload
        });
      try {
        const duplicate = await check({ enterpriseKey, name: "A组" });
        expect(duplicate.statusCode, duplicate.body).toBe(200);
        expect(duplicate.json()).toEqual({ duplicate: true });
        expect(
          (await check({ enterpriseKey, name: "A组", excludeDepartmentId: departmentId })).json()
        ).toEqual({ duplicate: false });
        expect((await check({ enterpriseKey: otherEnterpriseKey, name: "A组" })).json()).toEqual({
          duplicate: false
        });
        expect((await check({ enterpriseKey, name: "A组 " })).statusCode).toBe(400);
        expect((await check({ enterpriseKey, name: "A组" }, "unrelated")).statusCode).toBe(403);
        principal = { ...actor, id: employeeId };
        expect((await check({ enterpriseKey, name: "A组" })).statusCode).toBe(403);
        principal = null;
        expect((await check({ enterpriseKey, name: "A组" })).statusCode).toBe(401);

        const conflictingWrite = await call("manage_department", {
          operation: { kind: "create", name: "A组" }
        });
        expect(conflictingWrite.statusCode).toBe(409);
        expect(conflictingWrite.json().error.code).toBe("DIRECTORY_DUPLICATE_NAME");
      } finally {
        await web.close();
      }
    });

    it("rejects creating a department whose name already exists in the enterprise", async () => {
      const created = await call("manage_department", {
        operation: { kind: "create", name: "烧烤部" }
      });
      expect(created.statusCode, created.body).toBe(200);

      const duplicate = await call("manage_department", {
        operation: { kind: "create", name: "烧烤部" }
      });
      expect(duplicate.statusCode, duplicate.body).toBe(409);
      expect(duplicate.json().error.code).toBe("DIRECTORY_DUPLICATE_NAME");
      expect(
        await prisma.businessDepartment.count({ where: { orgId, enterpriseKey, name: "烧烤部" } })
      ).toBe(1);
    });

    it("rejects renaming onto another department name but allows an unchanged name", async () => {
      const first = (
        await call("manage_department", { operation: { kind: "create", name: "凉菜部" } })
      ).json();
      const second = (
        await call("manage_department", { operation: { kind: "create", name: "面点部" } })
      ).json();

      const collision = await call("manage_department", {
        operation: {
          kind: "rename",
          departmentId: second.departmentId,
          expectedVersion: "0",
          name: "凉菜部"
        }
      });
      expect(collision.statusCode, collision.body).toBe(409);
      expect(collision.json().error.code).toBe("DIRECTORY_DUPLICATE_NAME");
      expect(
        await prisma.businessDepartment.findUniqueOrThrow({
          where: { departmentId: second.departmentId }
        })
      ).toMatchObject({ name: "面点部", version: 0n });

      const unchanged = await call("manage_department", {
        operation: {
          kind: "rename",
          departmentId: first.departmentId,
          expectedVersion: "0",
          name: "凉菜部"
        }
      });
      expect(unchanged.statusCode, unchanged.body).toBe(200);
      expect(unchanged.json().version).toBe("1");
      expect(
        await prisma.businessDepartment.findUniqueOrThrow({
          where: { departmentId: first.departmentId }
        })
      ).toMatchObject({ name: "凉菜部", version: 1n });
    });

    it("rejects department names with leading or trailing whitespace without rewriting them", async () => {
      const padded = await call("manage_department", {
        operation: { kind: "create", name: " 甜点部 " }
      });
      expect(padded.statusCode, padded.body).toBe(400);
      expect(padded.json().error.code).toBe("DIRECTORY_INVALID_REQUEST");
      expect(
        await prisma.businessDepartment.count({
          where: { orgId, enterpriseKey, name: { in: [" 甜点部 ", "甜点部"] } }
        })
      ).toBe(0);

      const valid = (
        await call("manage_department", { operation: { kind: "create", name: "合规部" } })
      ).json();
      const paddedRename = await call("manage_department", {
        operation: {
          kind: "rename",
          departmentId: valid.departmentId,
          expectedVersion: "0",
          name: "合规部 "
        }
      });
      expect(paddedRename.statusCode, paddedRename.body).toBe(400);
      expect(
        await prisma.businessDepartment.findUniqueOrThrow({
          where: { departmentId: valid.departmentId }
        })
      ).toMatchObject({ name: "合规部", version: 0n });
    });

    it("keeps retired department names reserved and enforces the database invariant", async () => {
      const retired = (
        await call("manage_department", { operation: { kind: "create", name: "外卖部" } })
      ).json();
      expect(
        (
          await call("manage_department", {
            operation: {
              kind: "retire",
              departmentId: retired.departmentId,
              expectedVersion: "0"
            }
          })
        ).statusCode
      ).toBe(200);

      const duplicateCreate = await call("manage_department", {
        operation: { kind: "create", name: "外卖部" }
      });
      expect(duplicateCreate.statusCode, duplicateCreate.body).toBe(409);
      expect(duplicateCreate.json().error.code).toBe("DIRECTORY_DUPLICATE_NAME");

      const other = (
        await call("manage_department", { operation: { kind: "create", name: "夜宵部" } })
      ).json();
      const duplicateRename = await call("manage_department", {
        operation: {
          kind: "rename",
          departmentId: other.departmentId,
          expectedVersion: "0",
          name: "外卖部"
        }
      });
      expect(duplicateRename.statusCode, duplicateRename.body).toBe(409);
      expect(duplicateRename.json().error.code).toBe("DIRECTORY_DUPLICATE_NAME");
      expect(
        await prisma.businessDepartment.findUniqueOrThrow({
          where: { departmentId: other.departmentId }
        })
      ).toMatchObject({ name: "夜宵部", version: 0n });

      await expect(
        prisma.businessDepartment.create({
          data: { orgId, enterpriseKey, departmentId: randomUUID(), name: "夜宵部" }
        })
      ).rejects.toMatchObject({ code: "P2002" });
      expect(
        await prisma.businessDepartment.count({ where: { orgId, enterpriseKey, name: "夜宵部" } })
      ).toBe(1);
    });

    it("allows the same department name in a different enterprise", async () => {
      const name = "跨企业同名";
      const first = await call("manage_department", { operation: { kind: "create", name } });
      expect(first.statusCode, first.body).toBe(200);
      const second = await call("manage_department", {
        enterpriseKey: otherEnterpriseKey,
        operation: { kind: "create", name }
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(
        await prisma.businessDepartment.count({
          where: { orgId, enterpriseKey: { in: [enterpriseKey, otherEnterpriseKey] }, name }
        })
      ).toBe(2);
    });

    it("serializes concurrent creates of the same department name", async () => {
      const name = "并行部";
      const [first, second] = await Promise.all([
        call("manage_department", { operation: { kind: "create", name } }),
        call("manage_department", { operation: { kind: "create", name } })
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const rejected = first.statusCode === 409 ? first : second;
      expect(rejected.json().error.code).toBe("DIRECTORY_DUPLICATE_NAME");
      expect(await prisma.businessDepartment.count({ where: { orgId, enterpriseKey, name } })).toBe(
        1
      );
    });
  }
);
