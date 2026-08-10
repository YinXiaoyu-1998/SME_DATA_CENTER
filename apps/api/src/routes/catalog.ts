import type { FastifyInstance } from "fastify";
import { PUBLIC_INPUT_LIMITS } from "@enterprise-hub/domain";
import type { AuditLogRecord, CatalogLabel, DocumentCatalogRepository } from "../documents.js";
import type { SkillDirectoryEntry, SkillDirectoryRepository } from "../skills.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse, validationError } from "../request-errors.js";

interface AuditListQuery {
  limit?: string;
  cursor?: string;
}

interface SkillListQuery {
  q?: string;
  category?: string;
}

function labelCatalogResponse(label: CatalogLabel) {
  return {
    key: label.key,
    name: label.name,
    type: label.type
  };
}

function auditEventResponse(auditLog: AuditLogRecord) {
  return {
    id: auditLog.id,
    actorEmployeeId: auditLog.actorEmployeeId,
    action: auditLog.action,
    targetType: auditLog.targetType,
    targetId: auditLog.targetId,
    result: auditLog.result,
    metadata: auditLog.metadata,
    requestId: auditLog.requestId,
    clientIp: auditLog.clientIp,
    clientSource: auditLog.clientSource,
    launcherVersion: auditLog.launcherVersion,
    createdAt: auditLog.createdAt.toISOString()
  };
}

function skillDirectoryResponse(skill: SkillDirectoryEntry) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    category: skill.category,
    inputRequirements: skill.inputRequirements,
    installInstructions: skill.installInstructions,
    examplePrompts: skill.examplePrompts,
    status: skill.status
  };
}

function parseLimit(value: string | undefined): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("Invalid limit.");
  }

  return parsed;
}

function parseCursor(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value.length > PUBLIC_INPUT_LIMITS.cursorChars || !/^\d+$/.test(value)) {
    throw new Error("Invalid cursor.");
  }

  return value;
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    documents: () => DocumentCatalogRepository;
    skills: () => SkillDirectoryRepository;
  }
): void {
  app.get("/labels", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);
    const labels = await dependencies.documents().listLabels(employee.orgId);

    return {
      labels: labels.map(labelCatalogResponse)
    };
  });

  app.get<{ Querystring: SkillListQuery }>("/skills", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);
    const query = request.query;
    const skillEntries = await dependencies.skills().listApprovedSkills({
      orgId: employee.orgId,
      q: query.q?.trim() || null,
      category: query.category?.trim() || null
    });

    return {
      skills: skillEntries.map(skillDirectoryResponse)
    };
  });

  app.get<{ Querystring: AuditListQuery }>("/audit", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);

    if (employee.role !== "admin") {
      return reply.code(403).send(errorResponse("FORBIDDEN", "Admin access is required."));
    }

    let limit: number;
    let cursor: string | null;

    try {
      limit = parseLimit(request.query.limit);
      cursor = parseCursor(request.query.cursor);
    } catch {
      return validationError(reply, "INVALID_AUDIT_QUERY", "Audit query pagination is invalid.");
    }

    const result = await dependencies.documents().listAuditLogs({
      orgId: employee.orgId,
      limit,
      cursor
    });

    return {
      auditEvents: result.auditLogs.map(auditEventResponse),
      nextCursor: result.nextCursor
    };
  });
}
