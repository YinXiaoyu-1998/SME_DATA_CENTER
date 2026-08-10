import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH_ERROR_CODES, type AuthenticatedEmployee } from "@enterprise-hub/domain";
import type { ApiServerContext } from "./app-context.js";
import { errorResponse } from "./request-errors.js";

export interface AuthenticatedRequest extends FastifyRequest {
  employee: AuthenticatedEmployee;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

export function createRequestAuth(context: ApiServerContext) {
  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const token = bearerToken(request);

    if (!token) {
      reply
        .code(401)
        .send(errorResponse(AUTH_ERROR_CODES.unauthenticated, "Authentication is required."));
      return false;
    }

    try {
      const employee = await context.authenticateOfficialAccessToken(token, request);
      if (!employee) {
        reply
          .code(401)
          .send(errorResponse(AUTH_ERROR_CODES.unauthenticated, "Authentication is required."));
        return false;
      }

      if (employee.disabled) {
        reply
          .code(403)
          .send(errorResponse(AUTH_ERROR_CODES.employeeDisabled, "Employee account is disabled."));
        return false;
      }

      (request as AuthenticatedRequest).employee = employee;
      return true;
    } catch {
      reply
        .code(401)
        .send(errorResponse(AUTH_ERROR_CODES.unauthenticated, "Authentication is required."));
      return false;
    }
  }

  return {
    authenticate,
    employee(request: FastifyRequest): AuthenticatedEmployee {
      return (request as AuthenticatedRequest).employee;
    }
  };
}
