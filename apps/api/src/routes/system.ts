import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import type { ReadinessReport } from "../../../../scripts/readiness.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse } from "../request-errors.js";

const SERVICE_NAME = "enterprise-hub-api";

function isLoopbackRequest(ip: string): boolean {
  return (
    ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "0:0:0:0:0:0:0:1"
  );
}

function employeeResponse(employee: AuthenticatedEmployee) {
  return {
    id: employee.id,
    orgId: employee.orgId,
    organizationName: employee.organizationName,
    displayName: employee.displayName,
    email: employee.email,
    role: employee.role,
    clearance: employee.clearance,
    disabled: employee.disabled
  };
}

export function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    readinessCheck: () => Promise<ReadinessReport>;
  }
): void {
  app.get("/healthz", async () => ({
    ok: true,
    service: SERVICE_NAME
  }));

  app.get("/readyz", async (request, reply) => {
    if (!isLoopbackRequest(request.ip)) {
      return reply.code(404).send(errorResponse("NOT_FOUND", "Not found."));
    }

    const report = await dependencies.readinessCheck();
    return reply.code(report.ok ? 200 : 503).send({
      ...report,
      service: SERVICE_NAME
    });
  });

  app.get("/me", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    return {
      employee: employeeResponse(dependencies.auth.employee(request))
    };
  });
}
