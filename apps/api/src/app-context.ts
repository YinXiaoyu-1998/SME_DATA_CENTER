import {
  createPrismaBusinessAuthorizationService,
  type BusinessAuthorizationService
} from "./business-authorization.js";
import {
  createLedgerPdfDelivery,
  createPrismaLedgerDeliveryRepository,
  type LedgerPdfDelivery
} from "@smedc/ledger-archive/delivery";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  createDatabaseAdapter,
  createPrismaPartitionDownloadRepository,
  type PartitionDownloadRepository
} from "@smedc/db";
import {
  createPrismaPartitionDownloadAuditRepository,
  type PartitionDownloadAuditRepository
} from "./routes/structured-partitions/downloads.js";
import { PrismaClient } from "@prisma/client";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { loadApiRuntimeLimits, type ApiRuntimeLimits } from "./config/runtime-limits.js";
import {
  createPrismaDocumentCatalogRepository,
  type DocumentCatalogRepository
} from "./documents.js";
import type { EmployeeRepository } from "./employees.js";
import { createPrismaEvidenceSearchRepository, type EvidenceSearchRepository } from "./evidence.js";
import {
  createPrismaUploadAuthorizationAuditRepository,
  type UploadAuthorizationAuditRepository
} from "./file-upload-authorization.js";
import { createPrismaSkillDirectoryRepository, type SkillDirectoryRepository } from "./skills.js";
import {
  createPrismaStructuredImportRepository,
  type StructuredImportRepository
} from "./structured-imports.js";
import {
  createPrismaStructuredPartitionRepository,
  type StructuredPartitionRepository
} from "./structured-partitions.js";
import {
  createPrismaStructuredQueryRepository,
  type StructuredQueryRepository
} from "./structured-query.js";
import {
  createPrismaStructuredCoverageRepository,
  type StructuredCoverageRepository
} from "./structured-coverage.js";
import {
  createPrismaQuarantineCertificateRepository,
  type QuarantineCertificateRepository
} from "./quarantine-certificates.js";
import {
  createPrismaSourceDocumentRepository,
  type SourceDocumentRepository
} from "./source-documents.js";
import {
  createSourceDocumentDownloadIssuer,
  type SourceDocumentDownloadIssuer
} from "./source-document-downloads.js";
import { createOriginalObjectKey, createStorageAdapter, type StorageAdapter } from "@smedc/storage";
import { AuthCore, type AuthRequestAudit } from "./auth/auth-core.js";
import { createPrismaAuthCoreRepository } from "./auth/prisma-auth-repository.js";
import { checkRuntimeReadiness, type ReadinessReport } from "../../../scripts/readiness.js";
import {
  createRequestAuditContext,
  verifyInternalDelegationProof,
  type RequestAuditContext
} from "./request-audit-context.js";

export interface ApiServerOptions {
  businessAuthorizationService?: BusinessAuthorizationService & { disconnect?(): Promise<void> };
  ledgerPdfDelivery?: LedgerPdfDelivery;
  employeeRepository?: EmployeeRepository;
  documentRepository?: DocumentCatalogRepository;
  structuredImportRepository?: StructuredImportRepository;
  structuredPartitionRepository?: StructuredPartitionRepository;
  partitionDownloadRepository?: PartitionDownloadRepository;
  partitionDownloadAuditRepository?: PartitionDownloadAuditRepository;
  skillRepository?: SkillDirectoryRepository;
  structuredQueryRepository?: StructuredQueryRepository;
  structuredCoverageRepository?: StructuredCoverageRepository;
  quarantineCertificateRepository?: QuarantineCertificateRepository;
  sourceDocumentRepository?: SourceDocumentRepository;
  sourceDocumentDownloadIssuer?: SourceDocumentDownloadIssuer;
  evidenceRepository?: EvidenceSearchRepository;
  uploadAuthorizationAuditRepository?: UploadAuthorizationAuditRepository;
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
  readinessCheck?: () => Promise<ReadinessReport>;
  internalDelegationProof?: string;
}

export interface ApiServerContext {
  permissions: () => BusinessAuthorizationService;
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
  ledgerPdfs: () => LedgerPdfDelivery;
  documents: () => DocumentCatalogRepository;
  storage: () => StorageAdapter;
  structuredImports: () => StructuredImportRepository;
  structuredPartitions: () => StructuredPartitionRepository;
  partitionDownloads: () => PartitionDownloadRepository;
  partitionDownloadAudit: () => PartitionDownloadAuditRepository;
  structuredQueries: () => StructuredQueryRepository;
  structuredCoverage: () => StructuredCoverageRepository;
  quarantineCertificates: () => QuarantineCertificateRepository;
  sourceDocuments: () => SourceDocumentRepository;
  sourceDocumentDownloads: () => SourceDocumentDownloadIssuer;
  skills: () => SkillDirectoryRepository;
  evidence: () => EvidenceSearchRepository;
  uploadAuthorizationAudit: () => UploadAuthorizationAuditRepository;
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
  let permissionService = options.businessAuthorizationService;
  function permissions() {
    if (!permissionService) {
      const url = environment["DATABASE_URL"];
      if (!url) throw new Error("DATABASE_URL is required for business permissions.");
      permissionService = createPrismaBusinessAuthorizationService(url);
    }
    return permissionService;
  }
  const delegationProof = options.internalDelegationProof ?? randomBytes(32).toString("base64url");
  const legacyEmployeeRepository = options.employeeRepository;
  let ledgerPdfDelivery = options.ledgerPdfDelivery;
  let ledgerPrisma: PrismaClient | undefined;
  let documentRepository = options.documentRepository;
  let structuredImportRepository = options.structuredImportRepository;
  let structuredPartitionRepository = options.structuredPartitionRepository;
  let partitionDownloadRepository = options.partitionDownloadRepository;
  let partitionDownloadAuditRepository = options.partitionDownloadAuditRepository;
  let skillRepository = options.skillRepository;
  let structuredQueryRepository = options.structuredQueryRepository;
  let structuredCoverageRepository = options.structuredCoverageRepository;
  let quarantineCertificateRepository = options.quarantineCertificateRepository;
  let sourceDocumentRepository = options.sourceDocumentRepository;
  let sourceDocumentDownloadIssuer = options.sourceDocumentDownloadIssuer;
  let evidenceRepository = options.evidenceRepository;
  let uploadAuthorizationAuditRepository = options.uploadAuthorizationAuditRepository;
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
    authPrisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    authCore = new AuthCore(createPrismaAuthCoreRepository(authPrisma));
  }

  function authenticationClientSource(request: FastifyRequest) {
    if (
      request.url === "/mcp" ||
      request.url.startsWith("/mcp?") ||
      verifyInternalDelegationProof(request.headers["x-smedc-internal-delegation"], delegationProof)
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

  function ledgerPdfs(): LedgerPdfDelivery {
    if (!ledgerPdfDelivery) {
      const databaseUrl = environment["DATABASE_URL"];
      if (!databaseUrl) throw new Error("DATABASE_URL is required for ledger PDF delivery.");
      ledgerPrisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
      ledgerPdfDelivery = createLedgerPdfDelivery({
        repository: createPrismaLedgerDeliveryRepository({
          prisma: ledgerPrisma,
          storage: storage(),
          objectKeyPrefix:
            "keyPrefix" in storage()
              ? String((storage() as StorageAdapter & { keyPrefix: string }).keyPrefix)
              : ""
        }),
        storage: storage(),
        cursorSecret: cursorSigningSecret
      });
    }
    return ledgerPdfDelivery;
  }

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

  function structuredPartitions(): StructuredPartitionRepository {
    structuredPartitionRepository ??= createPrismaStructuredPartitionRepository({
      transactionTimeoutMs: runtimeLimits.structuredImportTransactionTimeoutMs
    });
    return structuredPartitionRepository;
  }

  function partitionDownloads(): PartitionDownloadRepository {
    partitionDownloadRepository ??= createPrismaPartitionDownloadRepository({
      databaseUrl: environment["DATABASE_URL"],
      limits: runtimeLimits,
      transactionTimeoutMs: runtimeLimits.structuredImportTransactionTimeoutMs
    });
    return partitionDownloadRepository;
  }
  function partitionDownloadAudit(): PartitionDownloadAuditRepository {
    partitionDownloadAuditRepository ??= createPrismaPartitionDownloadAuditRepository(
      environment["DATABASE_URL"]
    );
    return partitionDownloadAuditRepository;
  }

  function structuredQueries(): StructuredQueryRepository {
    structuredQueryRepository ??= createPrismaStructuredQueryRepository();
    return structuredQueryRepository;
  }

  function structuredCoverage(): StructuredCoverageRepository {
    structuredCoverageRepository ??= createPrismaStructuredCoverageRepository();
    return structuredCoverageRepository;
  }

  function quarantineCertificates(): QuarantineCertificateRepository {
    quarantineCertificateRepository ??= createPrismaQuarantineCertificateRepository();
    return quarantineCertificateRepository;
  }

  function sourceDocuments(): SourceDocumentRepository {
    sourceDocumentRepository ??= createPrismaSourceDocumentRepository();
    return sourceDocumentRepository;
  }

  function sourceDocumentDownloads(): SourceDocumentDownloadIssuer {
    sourceDocumentDownloadIssuer ??= createSourceDocumentDownloadIssuer({
      repository: sourceDocuments(),
      storage: storage(),
      ledgerPdfDeliveryEnabled: runtimeLimits.ledgerPdfDeliveryEnabled
    });
    return sourceDocumentDownloadIssuer;
  }

  function skills(): SkillDirectoryRepository {
    skillRepository ??= createPrismaSkillDirectoryRepository();
    return skillRepository;
  }

  function evidence(): EvidenceSearchRepository {
    evidenceRepository ??= createPrismaEvidenceSearchRepository();
    return evidenceRepository;
  }

  function uploadAuthorizationAudit(): UploadAuthorizationAuditRepository {
    uploadAuthorizationAuditRepository ??= createPrismaUploadAuthorizationAuditRepository(
      environment["DATABASE_URL"]
    );
    return uploadAuthorizationAuditRepository;
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    await legacyEmployeeRepository?.disconnect?.();
    await permissionService?.disconnect?.();
    await authPrisma?.$disconnect();
    await ledgerPrisma?.$disconnect();
    await documentRepository?.disconnect?.();
    await structuredImportRepository?.disconnect?.();
    await structuredPartitionRepository?.disconnect?.();
    await partitionDownloadRepository?.disconnect();
    await partitionDownloadAuditRepository?.disconnect?.();
    await skillRepository?.disconnect?.();
    await structuredQueryRepository?.disconnect?.();
    await structuredCoverageRepository?.disconnect?.();
    await quarantineCertificateRepository?.disconnect?.();
    await sourceDocumentRepository?.disconnect?.();
    await evidenceRepository?.disconnect?.();
    await uploadAuthorizationAuditRepository?.disconnect?.();
  }

  return {
    permissions,
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
    ledgerPdfs,
    documents,
    storage,
    structuredImports,
    structuredPartitions,
    partitionDownloads,
    partitionDownloadAudit,
    structuredQueries,
    structuredCoverage,
    quarantineCertificates,
    sourceDocuments,
    sourceDocumentDownloads,
    skills,
    evidence,
    uploadAuthorizationAudit,
    close
  };
}

export { createOriginalObjectKey };
