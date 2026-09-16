import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { createApiServerContext } from "./app-context.js";

const employee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Employee One",
  email: "employee@example.com",
  role: "admin",
  disabled: false,
  clearance: 3
};

describe("API server context", () => {
  it("requires the existing cursor secret configuration", () => {
    expect(() =>
      createApiServerContext({
        logger: false,
        runtimeEnv: {
          SMEDC_PUBLIC_ORIGIN: "http://localhost:3000"
        },
        authenticateAccessToken: async () => employee
      })
    ).toThrow("CURSOR_SIGNING_SECRET is required to start the API.");
  });

  it("passes audit provenance to the configured token authenticator", async () => {
    const calls: unknown[] = [];
    const context = createApiServerContext({
      logger: false,
      cursorSigningSecret: "cursor-secret",
      authenticateAccessToken: async (token, audit) => {
        calls.push({ token, audit });
        return employee;
      }
    });

    const request = {
      id: "req_api_1",
      ip: "198.51.100.10",
      url: "/skills",
      headers: {
        authorization: "Bearer token",
        "x-request-id": "req_api_1"
      }
    };

    await context.authenticateOfficialAccessToken("token", request as never);

    expect(calls).toEqual([
      {
        token: "token",
        audit: {
          requestId: "req_api_1",
          sourceIp: "198.51.100.10",
          launcherVersion: null
        }
      }
    ]);
  });

  it("disconnects injected repositories once when closed", async () => {
    const disconnects = {
      employee: vi.fn(),
      documents: vi.fn(),
      imports: vi.fn(),
      skills: vi.fn(),
      queries: vi.fn(),
      coverage: vi.fn(),
      evidence: vi.fn()
    };
    const context = createApiServerContext({
      logger: false,
      cursorSigningSecret: "cursor-secret",
      authenticateAccessToken: async () => employee,
      employeeRepository: { disconnect: disconnects.employee } as never,
      documentRepository: { disconnect: disconnects.documents } as never,
      structuredImportRepository: { disconnect: disconnects.imports } as never,
      skillRepository: { disconnect: disconnects.skills } as never,
      structuredQueryRepository: { disconnect: disconnects.queries } as never,
      structuredCoverageRepository: { disconnect: disconnects.coverage } as never,
      evidenceRepository: { disconnect: disconnects.evidence } as never
    });

    await context.close();
    await context.close();

    expect(disconnects.employee).toHaveBeenCalledTimes(1);
    expect(disconnects.documents).toHaveBeenCalledTimes(1);
    expect(disconnects.imports).toHaveBeenCalledTimes(1);
    expect(disconnects.skills).toHaveBeenCalledTimes(1);
    expect(disconnects.queries).toHaveBeenCalledTimes(1);
    expect(disconnects.coverage).toHaveBeenCalledTimes(1);
    expect(disconnects.evidence).toHaveBeenCalledTimes(1);
  });
});
