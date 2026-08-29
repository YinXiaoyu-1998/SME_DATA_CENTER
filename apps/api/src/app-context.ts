import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import { loadApiRuntimeLimits, type ApiRuntimeLimits } from "./config/runtime-limits.js";
import {
  createPrismaDocumentCatalogRepository,
  type DocumentCatalogRepository
} from "./documents.js";
import type { EmployeeRepository } from "./employees.js";
import { createPrismaEvidenceSearchRepository, type EvidenceSearchRepository } from "./evidence.js";
import { createPrismaSkillDirectoryRepository, type SkillDirectoryRepository } from "./skills.js";
import {
  createPrismaStructuredImportRepository,
  type StructuredImportRepository
} from "./structured-imports.js";
import {
  createPrismaStructuredQueryRepository,
  type StructuredQueryRepository
} from "./structured-query.js";
import {
  createOriginalObjectKey,
  createStorageAdapter,
  type StorageAdapter
} from "@enterprise-hub/storage";
import { AuthCore, type AuthRequestAudit } from "./auth/auth-core.js";
import { createPrismaAuthCoreRepository } from "./auth/prisma-auth-repository.js";
import { checkRuntimeReadiness, type ReadinessReport } from "../../../scripts/readiness.js";
import {
  createRequestAuditContext,
  verifyInternalDelegationProof,
  type RequestAuditContext
} from "./request-audit-context.js";

export interface ApiServerOptions {
  employeeRepository?: EmployeeRepository;
  documentRepository?: DocumentCatalogRepository;
  structuredImportRepository?: StructuredImportRepository;
  skillRepository?: SkillDirectoryRepository;
  structuredQueryRepository?: StructuredQueryRepository;
  evidenceRepository?: EvidenceSearchRepository;
  storageAdapter?: StorageAdapter;
  authCore?: AuthCore;
  authenticateAccessToken?: (
    token: string,
    audit: AuthRequestAudit
  ) => Promise<AuthenticatedEmployee | null>;
  cursorSigningSecret?: string;
  logger?: boolean;
  runtimeLimits?: ApiRuntimeLimits;
  runtimeEnv?: NodeJS.ProcessEnv;
  structuredImportProfiler?: typeof import("@enterprise-hub/structured-ingestion").profileStructuredFile;
  readinessCheck?: () => Promise<ReadinessReport>;
  internalDelegationProof?: string;
}

export interface ApiServerContext {
  environment: NodeJS.ProcessEnv;
  delegationProof: string;
  runtimeLimits: ApiRuntimeLimits;
  cursorSigningSecret: string;
  readinessCheck: () => Promise<ReadinessReport>;
  authCore: AuthCore | undefined;
  authenticateOfficialAccessToken: (
    token: string,
    request: FastifyRequest
  ) => Promise<AuthenticatedEmployee | null>;
  authenticationClientSource: (request: FastifyRequest) => "http_api" | "mcp_launcher";
  createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
  documents: () => DocumentCatalogRepository;
  storage: () => StorageAdapter;
  structuredImports: () => StructuredImportRepository;
  structuredQueries: () => StructuredQueryRepository;
  skills: () => SkillDirectoryRepository;
  evidence: () => EvidenceSearchRepository;
  close: () => Promise<void>;
}

function requireCursorSigningSecret(environment: NodeJS.ProcessEnv): string {
  const secret = environment["CURSOR_SIGNING_SECRET"];
  if (!secret) {
    throw new Error("CURSOR_SIGNING_SECRET is required to start the API.");
  }
  return secret;
}

export function createApiServerContext(options: ApiServerOptions = {}): ApiServerContext {
  const environment = options.runtimeEnv ?? process.env;
  const delegationProof = options.internalDelegationProof ?? randomBytes(32).toString("base64url");
  const legacyEmployeeRepository = options.employeeRepository;
  let documentRepository = options.documentRepository;
  let structuredImportRepository = options.structuredImportRepository;
  let skillRepository = options.skillRepository;
  let structuredQueryRepository = options.structuredQueryRepository;
  let evidenceRepository = options.evidenceRepository;
  let storageAdapter = options.storageAdapter;
  const runtimeLimits = options.runtimeLimits ?? loadApiRuntimeLimits(environment);
  const cursorSigningSecret =
    options.cursorSigningSecret ?? requireCursorSigningSecret(environment);
  const readinessCheck = options.readinessCheck ?? (() => checkRuntimeReadiness());
  let authPrisma: PrismaClient | undefined;
  let authCore = options.authCore;
  let closed = false;

  if (!authCore && !options.authenticateAccessToken) {
    const databaseUrl = environment["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to start the official authentication service.");
    }
    authPrisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
    authCore = new AuthCore(createPrismaAuthCoreRepository(authPrisma));
  }

  function authenticationClientSource(request: FastifyRequest) {
    if (
      request.url === "/mcp" ||
      request.url.startsWith("/mcp?") ||
      verifyInternalDelegationProof(
        request.headers["x-enterprise-hub-internal-delegation"],
        delegationProof
      )
    ) {
      return "mcp_launcher" as const;
    }
    return "http_api" as const;
  }

  const authenticateOfficialAccessToken = (token: string, request: FastifyRequest) => {
    const context = createRequestAuditContext(request, authenticationClientSource(request));
    const audit: AuthRequestAudit = {
      requestId: context.requestId,
      sourceIp: context.sourceIp,
      launcherVersion: context.launcherVersion
    };
    if (options.authenticateAccessToken) {
      return options.authenticateAccessToken(token, audit);
    }
    if (!authCore) {
      throw new Error("Official authentication service is unavailable.");
    }
    return authCore.authenticateAccessToken(token, audit);
  };

  function documents(): DocumentCatalogRepository {
    documentRepository ??= createPrismaDocumentCatalogRepository();
    return documentRepository;
  }

  function storage(): StorageAdapter {
    storageAdapter ??= createStorageAdapter(environment);
    return storageAdapter;
  }

  function structuredImports(): StructuredImportRepository {
    structuredImportRepository ??= createPrismaStructuredImportRepository({
      transactionTimeoutMs: runtimeLimits.structuredImportTransactionTimeoutMs,
      batchInsertSize: runtimeLimits.structuredImportBatchInsertSize
    });
    return structuredImportRepository;
  }

  function structuredQueries(): StructuredQueryRepository {
    structuredQueryRepository ??= createPrismaStructuredQueryRepository();
    return structuredQueryRepository;
  }

  function skills(): SkillDirectoryRepository {
    skillRepository ??= createPrismaSkillDirectoryRepository();
    return skillRepository;
  }

  function evidence(): EvidenceSearchRepository {
    evidenceRepository ??= createPrismaEvidenceSearchRepository();
    return evidenceRepository;
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    await legacyEmployeeRepository?.disconnect?.();
    await authPrisma?.$disconnect();
    await documentRepository?.disconnect?.();
    await structuredImportRepository?.disconnect?.();
    await skillRepository?.disconnect?.();
    await structuredQueryRepository?.disconnect?.();
    await evidenceRepository?.disconnect?.();
  }

  return {
    environment,
    delegationProof,
    runtimeLimits,
    cursorSigningSecret,
    readinessCheck,
    authCore,
    authenticateOfficialAccessToken,
    authenticationClientSource,
    createBusinessRequestAudit(request) {
      return createRequestAuditContext(request, authenticationClientSource(request));
    },
    documents,
    storage,
    structuredImports,
    structuredQueries,
    skills,
    evidence,
    close
  };
}

export { createOriginalObjectKey };
