import { createHash, randomBytes } from "node:crypto";
import { extname } from "node:path";
import multipart from "@fastify/multipart";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  AUTH_ERROR_CODES,
  DEFAULT_RETRIEVAL_CONFIG_VERSION,
  STRUCTURED_DATASET_REGISTRIES,
  STRUCTURED_QUERY_LIMITS,
  StructuredQueryValidationError,
  canEmployeeAccessDocument,
  compileStructuredQuery,
  createStructuredCursor,
  isAllowedFileTypeForDocumentKind,
  PHASE3_FILE_TYPES,
  PHASE3_ERROR_CODES,
  type AuthenticatedEmployee,
  type Phase3FileType,
  type StructuredDatasetName
} from "@enterprise-hub/domain";
import { parseStructuredFile } from "@enterprise-hub/structured-ingestion";
import {
  createOriginalObjectKey,
  createStorageAdapter,
  type StorageAdapter
} from "@enterprise-hub/storage";
import {
  createPrismaDocumentCatalogRepository,
  type AuditLogRecord,
  type CatalogLabel,
  type DocumentCatalogRepository,
  type DocumentStatusRecord
} from "./documents.js";
import type { EmployeeRepository } from "./employees.js";
import {
  EvidenceSearchCursorError,
  createPrismaEvidenceSearchRepository,
  type EvidenceSearchRepository
} from "./evidence.js";
import {
  createPrismaSkillDirectoryRepository,
  type SkillDirectoryEntry,
  type SkillDirectoryRepository
} from "./skills.js";
import {
  createPrismaStructuredImportRepository,
  StructuredImportError,
  type StructuredImportBatchRecord,
  type StructuredImportRepository
} from "./structured-imports.js";
import { loadApiRuntimeLimits, type ApiRuntimeLimits } from "./config/runtime-limits.js";
import {
  createPrismaStructuredQueryRepository,
  type StructuredQueryRepository
} from "./structured-query.js";
import { registerMcpHttpRoute } from "./mcp/http.js";
import { AuthCore } from "./auth/auth-core.js";
import { createPrismaAuthCoreRepository } from "./auth/prisma-auth-repository.js";
import { registerOfficialAuthRoutes } from "./auth/routes.js";
import { checkRuntimeReadiness, type ReadinessReport } from "../../../scripts/readiness.js";

const SERVICE_NAME = "enterprise-hub-api";
export interface ApiServerOptions {
  employeeRepository?: EmployeeRepository;
  documentRepository?: DocumentCatalogRepository;
  structuredImportRepository?: StructuredImportRepository;
  skillRepository?: SkillDirectoryRepository;
  structuredQueryRepository?: StructuredQueryRepository;
  evidenceRepository?: EvidenceSearchRepository;
  storageAdapter?: StorageAdapter;
  authCore?: AuthCore;
  authenticateAccessToken?: (token: string) => Promise<AuthenticatedEmployee | null>;
  cursorSigningSecret?: string;
  logger?: boolean;
  runtimeLimits?: ApiRuntimeLimits;
  runtimeEnv?: NodeJS.ProcessEnv;
  readinessCheck?: () => Promise<ReadinessReport>;
}

interface AuthenticatedRequest extends FastifyRequest {
  employee: AuthenticatedEmployee;
}

interface MultipartFieldPart {
  type: "field";
  fieldname: string;
  value: unknown;
}

interface MultipartFilePart {
  type: "file";
  fieldname: string;
  filename: string;
  mimetype?: string;
  file: AsyncIterable<Buffer | Uint8Array | string>;
}

type MultipartPart = MultipartFieldPart | MultipartFilePart;

interface ParsedUpload {
  file?: {
    fileName: string;
    contentType?: string;
    body: Buffer;
  };
  title?: string;
  sourceSystem?: string;
  labelKeys: string[];
}

interface ParsedStructuredImportUpload {
  file?: {
    fileName: string;
    contentType?: string;
    body: Buffer;
  };
  dataset?: string;
  enterpriseName?: string;
  startDate?: string;
  endDate?: string;
  idempotencyKey?: string;
  labelKeys: string[];
}

interface EvidenceSearchBody {
  query?: unknown;
  filters?: {
    fileTypes?: unknown;
    documentIds?: unknown;
    labelIds?: unknown;
  };
  limit?: unknown;
  cursor?: unknown;
}

interface AuditListQuery {
  limit?: string;
  cursor?: string;
}

interface SkillListQuery {
  q?: string;
  category?: string;
}

function requireCursorSigningSecret(environment: NodeJS.ProcessEnv): string {
  const secret = environment["CURSOR_SIGNING_SECRET"];
  if (!secret) {
    throw new Error("CURSOR_SIGNING_SECRET is required to start the API.");
  }
  return secret;
}

function errorResponse(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

function phase3ErrorResponse(
  request: FastifyRequest,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
) {
  return {
    error: {
      code,
      message,
      retryable: false,
      details,
      requestId: request.id
    }
  };
}

function validationError(reply: FastifyReply, code: string, message: string) {
  return reply.code(400).send(errorResponse(code, message));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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
    orgId: employee.orgId,
    email: employee.email,
    role: employee.role,
    disabled: employee.disabled,
    labels: employee.labels
  };
}

function labelCatalogResponse(label: CatalogLabel) {
  return {
    key: label.key,
    name: label.name,
    type: label.type
  };
}

function createDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

async function parseUpload(request: FastifyRequest): Promise<ParsedUpload> {
  const upload: ParsedUpload = {
    labelKeys: []
  };

  const multipartRequest = request as unknown as { parts(): AsyncIterable<MultipartPart> };

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file") {
        continue;
      }

      upload.file = {
        fileName: part.filename,
        contentType: part.mimetype,
        body: await readMultipartFile(part.file)
      };
      continue;
    }

    const value = typeof part.value === "string" ? part.value.trim() : "";

    if (part.fieldname === "labelKeys[]" || part.fieldname === "labelKeys") {
      if (value) {
        upload.labelKeys.push(value);
      }
      continue;
    }

    if (part.fieldname === "title") {
      upload.title = value;
      continue;
    }

    if (part.fieldname === "sourceSystem") {
      upload.sourceSystem = value;
    }
  }

  upload.labelKeys = uniqueSorted(upload.labelKeys);
  return upload;
}

async function parseStructuredImportUpload(
  request: FastifyRequest
): Promise<ParsedStructuredImportUpload> {
  const upload: ParsedStructuredImportUpload = {
    labelKeys: []
  };

  const multipartRequest = request as unknown as { parts(): AsyncIterable<MultipartPart> };

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file") {
        continue;
      }

      upload.file = {
        fileName: part.filename,
        contentType: part.mimetype,
        body: await readMultipartFile(part.file)
      };
      continue;
    }

    const value = typeof part.value === "string" ? part.value.trim() : "";

    if (["labelKeys[]", "labelKeys", "labelIds[]", "labelIds"].includes(part.fieldname)) {
      if (value) {
        upload.labelKeys.push(value);
      }
      continue;
    }

    if (part.fieldname === "dataset") {
      upload.dataset = value;
      continue;
    }

    if (part.fieldname === "enterprise_name" || part.fieldname === "enterpriseName") {
      upload.enterpriseName = value;
      continue;
    }

    if (part.fieldname === "startDate") {
      upload.startDate = value;
      continue;
    }

    if (part.fieldname === "endDate") {
      upload.endDate = value;
      continue;
    }

    if (part.fieldname === "idempotencyKey") {
      upload.idempotencyKey = value;
    }
  }

  upload.labelKeys = uniqueSorted(upload.labelKeys);
  return upload;
}

async function readMultipartFile(file: MultipartFilePart["file"]): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of file) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function validateStructuredImportMetadata(upload: ParsedStructuredImportUpload):
  | {
      ok: true;
      dataset: StructuredDatasetName;
      fileType: Extract<Phase3FileType, "xlsx" | "csv">;
      startDate: string;
      endDate: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    } {
  if (!upload.file) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "File is required."
    };
  }

  if (!upload.dataset || !["dishes", "business"].includes(upload.dataset)) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "dataset must be dishes or business."
    };
  }

  if (!upload.enterpriseName) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "enterprise_name is required."
    };
  }

  if (!upload.idempotencyKey) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "idempotencyKey is required."
    };
  }

  if (!upload.startDate || !upload.endDate || !isDateWindow(upload.startDate, upload.endDate)) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.invalidDateWindow,
      message: "startDate and endDate must be valid YYYYMMDD dates."
    };
  }

  if (upload.labelKeys.length === 0) {
    return {
      ok: false,
      code: "UNLABELED_DOCUMENT",
      message: "Structured import must have labels."
    };
  }

  const fileType = fileTypeFromName(upload.file.fileName);

  if (fileType !== "xlsx" && fileType !== "csv") {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.unsupportedFileType,
      message: "Structured imports support XLSX or CSV only."
    };
  }

  return {
    ok: true,
    dataset: upload.dataset as StructuredDatasetName,
    fileType,
    startDate: upload.startDate,
    endDate: upload.endDate
  };
}

function fileTypeFromName(fileName: string): Phase3FileType | null {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension && PHASE3_FILE_TYPES.includes(extension as Phase3FileType)) {
    return extension as Phase3FileType;
  }

  return null;
}

function fileTypeFromFilename(fileName: string): Phase3FileType | null {
  const extension = extname(fileName).toLowerCase().replace(/^\./, "");
  return isAllowedFileTypeForDocumentKind("evidence", extension) ? extension : null;
}

function isDateWindow(startDate: string, endDate: string): boolean {
  const start = parseYyyyMmDd(startDate);
  const end = parseYyyyMmDd(endDate);

  return Boolean(start && end && start.getTime() <= end.getTime());
}

function parseYyyyMmDd(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) {
    return null;
  }

  return parseDateParts(value.slice(0, 4), value.slice(4, 6), value.slice(6, 8));
}

function parseDateParts(yearValue: string, monthValue: string, dayValue: string): Date | null {
  const year = Number.parseInt(yearValue, 10);
  const month = Number.parseInt(monthValue, 10);
  const day = Number.parseInt(dayValue, 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function canonicalStructuredImportFileName(input: {
  enterpriseName: string;
  dataset: StructuredDatasetName;
  startDate: string;
  endDate: string;
  fileType: "xlsx" | "csv";
}) {
  const enterpriseSegment =
    input.enterpriseName
      .trim()
      .split("")
      .map((character) => {
        if (/^[A-Za-z0-9-]$/.test(character)) {
          return character.toLowerCase();
        }

        return `u${character.codePointAt(0)?.toString(16) ?? "0"}`;
      })
      .join("_") || "enterprise";

  return `${enterpriseSegment}_${input.dataset}_${input.startDate}_${input.endDate}.${input.fileType}`;
}

function structuredImportFingerprint(input: {
  dataset: StructuredDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  labelKeys: string[];
  fileHash: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function hasStructuredImportCode(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  return (
    code === "IDEMPOTENCY_KEY_CONFLICT" ||
    code === "ACTIVE_IMPORT_EXISTS" ||
    code === "IMPORT_IN_PROGRESS"
  );
}

function structuredImportConflictMessage(code: string): string {
  if (code === "IDEMPOTENCY_KEY_CONFLICT") {
    return "Idempotency key was reused with different import content.";
  }

  if (code === "ACTIVE_IMPORT_EXISTS") {
    return "An active import already exists for this dataset date window.";
  }

  if (code === "IMPORT_IN_PROGRESS") {
    return "An import is already in progress for this dataset date window.";
  }

  return "Structured import conflict.";
}

function isLoopbackRequest(ip: string): boolean {
  return (
    ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "0:0:0:0:0:0:0:1"
  );
}

function structuredImportResponse(input: {
  importBatch: StructuredImportBatchRecord;
  document: {
    documentId: string;
    fileType: "xlsx" | "csv";
    storageObjectKey: string;
    originalFileName: string;
    status: "active" | "archived";
  };
}) {
  return {
    document: {
      documentId: input.document.documentId,
      documentKind: "structured",
      fileType: input.document.fileType,
      status: input.document.status,
      storageObjectKey: input.document.storageObjectKey,
      originalFileName: input.document.originalFileName
    },
    processing: {
      processingRunId: null,
      status: "succeeded"
    },
    importBatch: importBatchResponse(input.importBatch)
  };
}

function responseForReservedImport(importBatch: StructuredImportBatchRecord) {
  return structuredImportResponse({
    importBatch,
    document: {
      documentId: importBatch.sourceDocumentId,
      fileType: importBatch.sourceDocumentFileType,
      storageObjectKey: importBatch.storageObjectKey,
      originalFileName: importBatch.originalFileName,
      status: importBatch.sourceDocumentStatus === "archived" ? "archived" : "active"
    }
  });
}

function importBatchResponse(importBatch: StructuredImportBatchRecord) {
  return {
    importBatchId: importBatch.id,
    sourceDocumentId: importBatch.sourceDocumentId,
    dataset: importBatch.dataset,
    status: importBatch.status,
    startDate: importBatch.startDate,
    endDate: importBatch.endDate,
    sourceSheetSummary: importBatch.sourceSheetSummary,
    validationErrors: importBatch.validationErrors,
    totalRowCount: importBatch.totalRowCount,
    appliedRowCount: importBatch.appliedRowCount,
    queryableRowCount: importBatch.queryableRowCount
  };
}

function evidenceUploadResponse(document: DocumentStatusRecord) {
  return {
    document: {
      documentId: document.id,
      documentKind: "evidence",
      fileType: document.fileType,
      status: document.status
    },
    processing: {
      processingRunId: null,
      status: document.processingRunStatus
    },
    documentIndex: {
      status: document.documentIndexStatus ?? "pending",
      retrievalConfigVersion: DEFAULT_RETRIEVAL_CONFIG_VERSION
    }
  };
}

function evidenceStatusResponse(document: DocumentStatusRecord) {
  return {
    document: {
      documentId: document.id,
      documentKind: document.documentKind,
      fileType: document.fileType,
      title: document.title,
      status: document.status,
      labels: document.labels,
      originalFileName: document.originalFileName,
      sourceSystem: document.sourceSystem
    },
    processing: {
      processingRunId: null,
      status: document.processingRunStatus
    },
    documentIndex: {
      status: document.documentIndexStatus ?? "pending",
      retrievalConfigVersion: DEFAULT_RETRIEVAL_CONFIG_VERSION
    }
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

function structuredFieldResponse(
  field: (typeof STRUCTURED_DATASET_REGISTRIES)[keyof typeof STRUCTURED_DATASET_REGISTRIES]["fields"][number]
) {
  return {
    canonicalName: field.canonicalName,
    sourceColumn: field.sourceColumn,
    aliases: field.aliases,
    type: field.type,
    nullable: field.nullable,
    sensitivity: field.sensitivity,
    lifecycle: field.lifecycle,
    volatility: field.volatility,
    defaultReturn: field.defaultReturn,
    operators: field.operators,
    capabilities: field.capabilities,
    indexStatus: field.indexStatus,
    valueLimits: field.valueLimits,
    storage: field.storage
  };
}

function structuredDatasetRegistryResponse() {
  return {
    limits: STRUCTURED_QUERY_LIMITS,
    datasets: Object.values(STRUCTURED_DATASET_REGISTRIES).map((registry) => ({
      dataset: registry.dataset,
      registryVersion: registry.version,
      rowTable: registry.rowTable,
      fields: registry.fields.map(structuredFieldResponse)
    }))
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

  if (!/^\d+$/.test(value)) {
    throw new Error("Invalid cursor.");
  }

  return value;
}

function mergeLabels(requestedLabels: CatalogLabel[], personalLabel: CatalogLabel | null) {
  const labelsByKey = new Map(requestedLabels.map((label) => [label.key, label]));

  if (personalLabel) {
    labelsByKey.set(personalLabel.key, personalLabel);
  }

  return [...labelsByKey.values()].sort((first, second) => first.key.localeCompare(second.key));
}

function forbiddenRequestedLabels(
  employee: AuthenticatedEmployee,
  labels: CatalogLabel[]
): string[] {
  if (employee.role === "admin") {
    return [];
  }

  return labels
    .filter((label) => label.type === "all_staff" || !employee.labels.includes(label.key))
    .map((label) => label.key)
    .sort();
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticateAccessToken: (token: string) => Promise<AuthenticatedEmployee | null>
): Promise<boolean> {
  const token = bearerToken(request);

  if (!token) {
    reply
      .code(401)
      .send(errorResponse(AUTH_ERROR_CODES.unauthenticated, "Authentication is required."));
    return false;
  }

  try {
    const employee = await authenticateAccessToken(token);
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
  const environment = options.runtimeEnv ?? process.env;
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
  if (!authCore && !options.authenticateAccessToken) {
    const databaseUrl = environment["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to start the official authentication service.");
    }
    authPrisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
    authCore = new AuthCore(createPrismaAuthCoreRepository(authPrisma));
  }
  const authenticateOfficialAccessToken =
    options.authenticateAccessToken ??
    ((token: string) => {
      if (!authCore) {
        throw new Error("Official authentication service is unavailable.");
      }
      return authCore.authenticateAccessToken(token);
    });

  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: "x-request-id"
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onClose", async () => {
    await legacyEmployeeRepository?.disconnect?.();
    await authPrisma?.$disconnect();
    await documentRepository?.disconnect?.();
    await structuredImportRepository?.disconnect?.();
    await skillRepository?.disconnect?.();
    await structuredQueryRepository?.disconnect?.();
    await evidenceRepository?.disconnect?.();
  });

  void app.register(multipart, {
    limits: {
      fileSize: runtimeLimits.maxUploadBytes
    }
  });

  registerMcpHttpRoute(app, {
    maxUploadBytes: runtimeLimits.maxUploadBytes,
    mcpMaxConcurrentRequests: runtimeLimits.mcpMaxConcurrentRequests,
    publicOrigin: (options.runtimeEnv ?? process.env)["ENTERPRISE_HUB_PUBLIC_ORIGIN"],
    authenticate: async (request, reply) => {
      const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

      if (!authenticated) {
        return null;
      }

      return (request as AuthenticatedRequest).employee;
    }
  });

  if (authCore) {
    const publicOrigin = environment["ENTERPRISE_HUB_PUBLIC_ORIGIN"];
    if (!publicOrigin) {
      throw new Error("ENTERPRISE_HUB_PUBLIC_ORIGIN is required for official authentication.");
    }
    registerOfficialAuthRoutes(app, { auth: authCore, publicOrigin });
    void authCore.pruneSecurityEvents().catch((error: unknown) => {
      app.log.error({ err: error }, "Failed to prune expired authentication security events.");
    });
    const pruneTimer = setInterval(
      () => {
        void authCore?.pruneSecurityEvents().catch((error: unknown) => {
          app.log.error({ err: error }, "Failed to prune expired authentication security events.");
        });
      },
      24 * 60 * 60 * 1000
    );
    pruneTimer.unref();
    app.addHook("onClose", async () => clearInterval(pruneTimer));
  }

  function documents(): DocumentCatalogRepository {
    documentRepository ??= createPrismaDocumentCatalogRepository();
    return documentRepository;
  }

  function storage(): StorageAdapter {
    storageAdapter ??= createStorageAdapter(options.runtimeEnv ?? process.env);
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

  app.get("/healthz", async () => ({
    ok: true,
    service: SERVICE_NAME
  }));

  app.get("/readyz", async (request, reply) => {
    if (!isLoopbackRequest(request.ip)) {
      return reply.code(404).send(errorResponse("NOT_FOUND", "Not found."));
    }

    const report = await readinessCheck();
    return reply.code(report.ok ? 200 : 503).send({
      ...report,
      service: SERVICE_NAME
    });
  });

  app.get("/me", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    return {
      employee: employeeResponse((request as AuthenticatedRequest).employee)
    };
  });

  app.post("/v1/documents/evidence", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    let upload: ParsedUpload;

    try {
      upload = await parseUpload(request);
    } catch {
      return validationError(reply, "INVALID_EVIDENCE_UPLOAD", "Multipart upload is invalid.");
    }

    if (!upload.file) {
      return validationError(reply, "INVALID_EVIDENCE_UPLOAD", "File is required.");
    }

    if (!upload.title) {
      return validationError(reply, "INVALID_EVIDENCE_UPLOAD", "Title is required.");
    }

    const fileType = fileTypeFromFilename(upload.file.fileName);

    if (!fileType) {
      return validationError(
        reply,
        PHASE3_ERROR_CODES.invalidDocumentKindFileType,
        "Evidence documents must be .md, .txt, or .docx files."
      );
    }

    const employee = (request as AuthenticatedRequest).employee;
    const orgId = employee.orgId;
    const requestedLabels = await documents().findLabelsByKeys(orgId, upload.labelKeys);
    const foundLabelKeys = new Set(requestedLabels.map((label) => label.key));
    const missingLabelKeys = upload.labelKeys.filter((labelKey) => !foundLabelKeys.has(labelKey));

    if (missingLabelKeys.length > 0) {
      return validationError(reply, "UNKNOWN_LABEL", "One or more labels do not exist.");
    }

    const forbiddenLabelKeys = forbiddenRequestedLabels(employee, requestedLabels);

    if (forbiddenLabelKeys.length > 0) {
      return reply
        .code(403)
        .send(errorResponse("FORBIDDEN_LABEL", "One or more labels cannot be assigned."));
    }

    const personalLabel = await documents().findPersonalLabelForEmployee(orgId, employee.id);
    const finalLabels = mergeLabels(requestedLabels, personalLabel);

    if (finalLabels.length === 0) {
      return validationError(reply, "UNLABELED_DOCUMENT", "Document must have at least one label.");
    }

    const documentId = createDocumentId();
    const storedObject = await storage().putObject({
      orgId,
      documentId,
      fileName: upload.file.fileName,
      body: upload.file.body,
      contentType: upload.file.contentType
    });

    try {
      const document = await documents().createUploadedDocument({
        id: documentId,
        orgId,
        title: upload.title,
        documentType: "management_knowledge",
        documentKind: "evidence",
        fileType,
        status: "pending_processing",
        storageObjectKey: storedObject.key,
        originalFileName: upload.file.fileName,
        contentType: storedObject.contentType,
        byteSize: storedObject.size,
        checksumSha256: storedObject.hash,
        uploaderId: employee.id,
        sourceSystem: upload.sourceSystem || null,
        sourceTime: null,
        labelIds: finalLabels.map((label) => label.id),
        labels: finalLabels.map((label) => label.key),
        processingJobType: "evidence_document_index",
        requestId: request.id,
        clientIp: request.ip
      });

      return reply.code(202).send(evidenceUploadResponse(document));
    } catch (error) {
      await storage().deleteObject(storedObject.key);
      request.log.error({ err: error, documentId }, "evidence document catalog write failed");
      return reply
        .code(500)
        .send(errorResponse("DOCUMENT_CATALOG_WRITE_FAILED", "Document catalog write failed."));
    }
  });

  app.get<{ Params: { documentId: string } }>(
    "/v1/documents/evidence/:documentId/status",
    async (request, reply) => {
      const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

      if (!authenticated) {
        return;
      }

      const employee = (request as AuthenticatedRequest).employee;
      const document = await documents().findEvidenceDocumentStatus(
        employee.orgId,
        request.params.documentId
      );

      if (!document) {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      if (document.uploaderId !== employee.id && employee.role !== "admin") {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      return evidenceStatusResponse(document);
    }
  );

  app.post<{ Body: EvidenceSearchBody }>("/v1/evidence/search", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    const query = typeof request.body.query === "string" ? request.body.query.trim() : "";

    if (!query) {
      return validationError(reply, PHASE3_ERROR_CODES.invalidQuery, "Query is required.");
    }

    const limit =
      typeof request.body.limit === "number" && Number.isInteger(request.body.limit)
        ? request.body.limit
        : 10;

    if (limit < 1 || limit > 50) {
      return validationError(reply, PHASE3_ERROR_CODES.limitExceeded, "Limit must be 1-50.");
    }

    const cursor =
      typeof request.body.cursor === "string" && request.body.cursor.trim()
        ? request.body.cursor.trim()
        : null;
    const filters = {
      fileTypes: stringArray(request.body.filters?.fileTypes),
      documentIds: stringArray(request.body.filters?.documentIds),
      labelIds: stringArray(request.body.filters?.labelIds)
    };
    const employee = (request as AuthenticatedRequest).employee;
    let result;
    try {
      result = await evidence().searchEvidence({
        orgId: employee.orgId,
        employee,
        query,
        filters,
        limit,
        cursor,
        cursorSecret: cursorSigningSecret,
        requestId: request.id,
        clientIp: request.ip
      });
    } catch (error) {
      if (error instanceof EvidenceSearchCursorError) {
        return reply.code(400).send(phase3ErrorResponse(request, error.code, error.message));
      }

      throw error;
    }

    return {
      ...result,
      requestId: request.id
    };
  });
  app.post("/v1/structured/imports", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    let upload: ParsedStructuredImportUpload;

    try {
      upload = await parseStructuredImportUpload(request);
    } catch {
      return validationError(
        reply,
        "INVALID_STRUCTURED_IMPORT_UPLOAD",
        "Multipart structured import upload is invalid."
      );
    }

    const metadataValidation = validateStructuredImportMetadata(upload);

    if (!metadataValidation.ok) {
      return validationError(reply, metadataValidation.code, metadataValidation.message);
    }

    const { dataset, fileType, startDate, endDate } = metadataValidation;
    const uploadedFile = upload.file;
    const enterpriseName = upload.enterpriseName;
    const idempotencyKey = upload.idempotencyKey;

    if (!uploadedFile || !enterpriseName || !idempotencyKey) {
      return validationError(
        reply,
        "INVALID_STRUCTURED_IMPORT_METADATA",
        "Structured import metadata is incomplete."
      );
    }

    const employee = (request as AuthenticatedRequest).employee;
    const requestedLabels = await documents().findLabelsByKeys(employee.orgId, upload.labelKeys);
    const foundLabelKeys = new Set(requestedLabels.map((label) => label.key));
    const missingLabelKeys = upload.labelKeys.filter((labelKey) => !foundLabelKeys.has(labelKey));

    if (missingLabelKeys.length > 0) {
      return validationError(reply, "UNKNOWN_LABEL", "One or more labels do not exist.");
    }

    const forbiddenLabelKeys = forbiddenRequestedLabels(employee, requestedLabels);

    if (forbiddenLabelKeys.length > 0) {
      return reply
        .code(403)
        .send(errorResponse("FORBIDDEN_LABEL", "One or more labels cannot be assigned."));
    }

    if (requestedLabels.length === 0) {
      return validationError(reply, "UNLABELED_DOCUMENT", "Structured import must have labels.");
    }

    let validation: Awaited<ReturnType<typeof parseStructuredFile>>;

    try {
      validation = await parseStructuredFile({
        dataset,
        content: uploadedFile.body,
        fileType,
        startDate,
        endDate,
        fileName: uploadedFile.fileName,
        limits: {
          maxStructuredImportRows: runtimeLimits.maxStructuredImportRows,
          maxXlsxSheets: runtimeLimits.maxXlsxSheets,
          maxStructuredCellChars: runtimeLimits.maxStructuredCellChars,
          maxXlsxUncompressedBytes: runtimeLimits.maxXlsxUncompressedBytes,
          maxXlsxZipEntries: runtimeLimits.maxXlsxZipEntries,
          maxXlsxCompressionRatio: runtimeLimits.maxXlsxCompressionRatio
        }
      });
    } catch (error) {
      return validationError(
        reply,
        "STRUCTURED_IMPORT_VALIDATION_FAILED",
        error instanceof Error ? error.message : "Structured import validation failed."
      );
    }

    const candidateDocumentId = createDocumentId();
    const originalFileName = uploadedFile.fileName;
    const canonicalFileName = canonicalStructuredImportFileName({
      enterpriseName,
      dataset,
      startDate,
      endDate,
      fileType
    });
    const fileHash = createHash("sha256").update(uploadedFile.body).digest("hex");
    const requestFingerprint = structuredImportFingerprint({
      dataset,
      enterpriseName,
      startDate,
      endDate,
      labelKeys: requestedLabels.map((label) => label.key).sort(),
      fileHash
    });
    const candidateStorageObjectKey = createOriginalObjectKey({
      orgId: employee.orgId,
      documentId: candidateDocumentId,
      fileName: canonicalFileName
    });

    let reservation: Awaited<ReturnType<StructuredImportRepository["reserveStructuredImport"]>>;
    try {
      reservation = await structuredImports().reserveStructuredImport({
        orgId: employee.orgId,
        actorEmployeeId: employee.id,
        documentId: candidateDocumentId,
        dataset,
        fileType,
        startDate,
        endDate,
        idempotencyKey,
        requestFingerprint,
        document: {
          title: `${enterpriseName}_${dataset}_${startDate}_${endDate}`,
          storageObjectKey: candidateStorageObjectKey,
          originalFileName,
          contentType: uploadedFile.contentType,
          byteSize: uploadedFile.body.byteLength,
          checksumSha256: fileHash,
          labelIds: requestedLabels.map((label) => label.id),
          labels: requestedLabels.map((label) => label.key).sort()
        },
        sourceSheetSummary: validation.sheetSummary,
        totalRowCount: validation.rows.length,
        requestId: request.id,
        clientIp: request.ip
      });
    } catch (error) {
      if (error instanceof StructuredImportError || hasStructuredImportCode(error)) {
        return reply
          .code(409)
          .send(errorResponse(error.code, structuredImportConflictMessage(error.code)));
      }
      request.log.error({ err: error }, "structured import reservation failed");
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }

    if (reservation.state === "existing") {
      return reply.code(202).send(responseForReservedImport(reservation.importBatch));
    }

    const reservedBatch = reservation.importBatch;
    try {
      const storedObject = await storage().putObject({
        orgId: employee.orgId,
        documentId: reservedBatch.sourceDocumentId,
        fileName: canonicalFileName,
        body: uploadedFile.body,
        contentType: uploadedFile.contentType
      });
      if (
        storedObject.key !== reservedBatch.storageObjectKey ||
        storedObject.hash !== fileHash ||
        storedObject.size !== uploadedFile.body.byteLength
      ) {
        throw new Error("Published structured import object does not match its reservation.");
      }
    } catch (error) {
      try {
        const authoritative = await structuredImports().markStructuredImportStorageFailure({
          orgId: employee.orgId,
          importBatchId: reservedBatch.id,
          errorCode: "STORAGE_WRITE_FAILED",
          errorSummary: error instanceof Error ? error.message : "Storage write failed."
        });
        if (authoritative.status === "applied") {
          return reply.code(202).send(responseForReservedImport(authoritative));
        }
      } catch (markError) {
        request.log.error({ err: markError }, "failed to record structured storage failure");
      }
      request.log.error({ err: error }, "structured import storage publication failed");
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }

    try {
      const importBatch = await structuredImports().applyReservedStructuredImport({
        orgId: employee.orgId,
        actorEmployeeId: employee.id,
        importBatchId: reservedBatch.id,
        rows: validation.rows,
        requestId: request.id,
        clientIp: request.ip
      });
      return reply.code(202).send(responseForReservedImport(importBatch));
    } catch (error) {
      request.log.error(
        { err: error, documentId: reservedBatch.sourceDocumentId },
        "structured import apply failed"
      );
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }
  });

  app.get<{ Params: { importBatchId: string } }>(
    "/v1/structured/imports/:importBatchId",
    async (request, reply) => {
      const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

      if (!authenticated) {
        return;
      }

      const employee = (request as AuthenticatedRequest).employee;
      const importBatch = await structuredImports().findImportBatch(
        employee.orgId,
        request.params.importBatchId
      );

      if (
        !importBatch ||
        !canEmployeeAccessDocument({
          employee: {
            disabled: employee.disabled,
            role: employee.role,
            labelKeys: employee.labels
          },
          document: {
            labelKeys: importBatch.sourceDocumentLabelKeys
          }
        })
      ) {
        return reply
          .code(404)
          .send(errorResponse("IMPORT_BATCH_NOT_FOUND", "Import batch not found."));
      }

      return {
        importBatch: importBatchResponse(importBatch)
      };
    }
  );
  app.get("/v1/structured/datasets", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    return structuredDatasetRegistryResponse();
  });
  app.post("/v1/structured/query", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;

    try {
      const compiled = compileStructuredQuery({
        orgId: employee.orgId,
        employee: {
          id: employee.id,
          role: employee.role,
          labels: employee.labels
        },
        query: request.body,
        cursorSecret: cursorSigningSecret
      });
      const result = await structuredQueries().execute(compiled);
      const nextCursor = result.hasMore
        ? createStructuredCursor({
            offset: compiled.offset + result.rows.length,
            shapeHash: compiled.shapeHash,
            secret: cursorSigningSecret
          })
        : null;

      return {
        dataset: compiled.dataset,
        registryVersion: compiled.registryVersion,
        mode: compiled.mode,
        rows: result.rows,
        nextCursor
      };
    } catch (error) {
      if (error instanceof StructuredQueryValidationError) {
        const statusCode =
          error.code === PHASE3_ERROR_CODES.datasetForbidden
            ? 403
            : error.code === PHASE3_ERROR_CODES.cursorExpired ||
                error.code === PHASE3_ERROR_CODES.invalidCursor
              ? 400
              : 400;

        return reply
          .code(statusCode)
          .send(phase3ErrorResponse(request, error.code, error.message, error.details));
      }

      throw error;
    }
  });

  app.get("/labels", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;
    const labels = await documents().listLabels(employee.orgId);

    return {
      labels: labels.map(labelCatalogResponse)
    };
  });

  app.get<{ Querystring: SkillListQuery }>("/skills", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;
    const query = request.query;
    const skillEntries = await skills().listApprovedSkills({
      orgId: employee.orgId,
      q: query.q?.trim() || null,
      category: query.category?.trim() || null
    });

    return {
      skills: skillEntries.map(skillDirectoryResponse)
    };
  });

  app.get<{ Querystring: AuditListQuery }>("/audit", async (request, reply) => {
    const authenticated = await authenticate(request, reply, authenticateOfficialAccessToken);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;

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

    const result = await documents().listAuditLogs({
      orgId: employee.orgId,
      limit,
      cursor
    });

    return {
      auditEvents: result.auditLogs.map(auditEventResponse),
      nextCursor: result.nextCursor
    };
  });

  return app;
}
