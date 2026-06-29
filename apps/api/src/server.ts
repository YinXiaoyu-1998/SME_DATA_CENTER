import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { AUTH_ERROR_CODES, type AuthenticatedEmployee } from "@enterprise-hub/domain";
import { createPrismaEmployeeRepository, type EmployeeRepository } from "./employees.js";
import { signEmployeeAccessToken, verifyEmployeeAccessToken } from "./tokens.js";

const SERVICE_NAME = "enterprise-hub-api";

export interface ApiServerOptions {
  employeeRepository?: EmployeeRepository;
  jwtSecret?: string;
  enableDevLogin?: boolean;
  logger?: boolean;
}

interface DevLoginBody {
  email?: string;
}

interface AuthenticatedRequest extends FastifyRequest {
  employee: AuthenticatedEmployee;
}

function requireJwtSecret(): string {
  const jwtSecret = process.env["JWT_SECRET"];

  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required to start the API.");
  }

  return jwtSecret;
}

function errorResponse(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

function employeeResponse(employee: AuthenticatedEmployee) {
  return {
    id: employee.id,
    email: employee.email,
    role: employee.role,
    disabled: employee.disabled,
    labels: employee.labels
  };
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: EmployeeRepository,
  jwtSecret: string
): Promise<boolean> {
  const token = bearerToken(request);

  if (!token) {
    reply
      .code(401)
      .send(errorResponse(AUTH_ERROR_CODES.unauthenticated, "Authentication is required."));
    return false;
  }

  try {
    const payload = await verifyEmployeeAccessToken(token, jwtSecret);
    const employee = await repository.findById(payload.employeeId);

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

export function buildApiServer(options: ApiServerOptions = {}) {
  const repository = options.employeeRepository ?? createPrismaEmployeeRepository();
  const jwtSecret = options.jwtSecret ?? requireJwtSecret();
  const enableDevLogin = options.enableDevLogin ?? process.env["NODE_ENV"] !== "production";

  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: "x-request-id"
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onClose", async () => {
    await repository.disconnect?.();
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: SERVICE_NAME
  }));

  app.post<{ Body: DevLoginBody }>("/auth/dev-login", async (request, reply) => {
    if (!enableDevLogin) {
      return reply
        .code(404)
        .send(
          errorResponse(AUTH_ERROR_CODES.devLoginUnavailable, "Development login is unavailable.")
        );
    }

    const email = request.body.email;

    if (!email) {
      return reply
        .code(400)
        .send(errorResponse(AUTH_ERROR_CODES.employeeNotFound, "Email is required."));
    }

    const employee = await repository.findByEmail(email);

    if (!employee) {
      return reply
        .code(404)
        .send(errorResponse(AUTH_ERROR_CODES.employeeNotFound, "Employee not found."));
    }

    if (employee.disabled) {
      return reply
        .code(403)
        .send(errorResponse(AUTH_ERROR_CODES.employeeDisabled, "Employee account is disabled."));
    }

    const accessToken = await signEmployeeAccessToken(employee, jwtSecret);

    return {
      accessToken,
      employee: employeeResponse(employee)
    };
  });

  app.get("/me", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    return {
      employee: employeeResponse((request as AuthenticatedRequest).employee)
    };
  });

  return app;
}
