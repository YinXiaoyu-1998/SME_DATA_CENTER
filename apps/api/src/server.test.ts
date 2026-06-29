import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import { buildApiServer } from "./server.js";
import { signEmployeeAccessToken } from "./tokens.js";
import type { EmployeeRepository } from "./employees.js";

const jwtSecret = "test-local-jwt-secret";

const adminEmployee: AuthenticatedEmployee = {
  id: "emp_admin",
  email: "admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:admin", "store:baoli", "store:suzhou"]
};

const disabledEmployee: AuthenticatedEmployee = {
  id: "emp_disabled",
  email: "disabled@example.com",
  role: "employee",
  disabled: true,
  labels: ["all_staff", "person:disabled"]
};

function createRepository(employees: AuthenticatedEmployee[]): EmployeeRepository {
  return {
    async findByEmail(email: string) {
      return employees.find((employee) => employee.email === email) ?? null;
    },
    async findById(id: string) {
      return employees.find((employee) => employee.id === id) ?? null;
    }
  };
}

function buildTestServer(employees = [adminEmployee, disabledEmployee]) {
  return buildApiServer({
    employeeRepository: createRepository(employees),
    jwtSecret,
    enableDevLogin: true,
    logger: false
  });
}

describe("api auth shell", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns the health check response", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/healthz"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "enterprise-hub-api"
    });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("issues a development token for a seeded employee without password fields", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: {
        email: "admin@example.com"
      }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.employee).toEqual(adminEmployee);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("returns the authenticated employee from /me", async () => {
    app = buildTestServer();
    const accessToken = await signEmployeeAccessToken(adminEmployee, jwtSecret);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      employee: adminEmployee
    });
  });

  it("rejects missing and invalid bearer tokens", async () => {
    app = buildTestServer();

    const missingToken = await app.inject({
      method: "GET",
      url: "/me"
    });
    const invalidToken = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: "Bearer not-a-real-token"
      }
    });

    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
    expect(invalidToken.statusCode).toBe(401);
    expect(invalidToken.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("rejects disabled employees even when the token is otherwise valid", async () => {
    app = buildTestServer();
    const accessToken = await signEmployeeAccessToken(disabledEmployee, jwtSecret);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "EMPLOYEE_DISABLED"
      }
    });
  });
});
