import { randomBytes } from "node:crypto";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  AUTH_ERROR_CODES,
  canEmployeeAccessDocument,
  isDocumentType,
  type AuthenticatedEmployee,
  type DocumentTypeName
} from "@enterprise-hub/domain";
import { LocalFileSystemStorageAdapter, type StorageAdapter } from "@enterprise-hub/storage";
import {
  createPrismaDocumentCatalogRepository,
  type AuditLogRecord,
  type CatalogLabel,
  type DocumentCatalogRepository,
  type DocumentQueryRecord,
  type DocumentStatusRecord
} from "./documents.js";
import { createPrismaEmployeeRepository, type EmployeeRepository } from "./employees.js";
import {
  createPrismaSkillDirectoryRepository,
  type SkillDirectoryEntry,
  type SkillDirectoryRepository
} from "./skills.js";
import { signEmployeeAccessToken, verifyEmployeeAccessToken } from "./tokens.js";

const SERVICE_NAME = "enterprise-hub-api";

export interface ApiServerOptions {
  employeeRepository?: EmployeeRepository;
  documentRepository?: DocumentCatalogRepository;
  skillRepository?: SkillDirectoryRepository;
  storageAdapter?: StorageAdapter;
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
  documentType?: string;
  sourceSystem?: string;
  sourceTime?: string;
  labelKeys: string[];
}

interface DocumentListQuery {
  q?: string;
  documentType?: string;
  labelKey?: string;
  limit?: string;
  cursor?: string;
}

interface DocumentLabelsBody {
  labelKeys?: unknown;
}

interface AuditListQuery {
  limit?: string;
  cursor?: string;
}

interface SkillListQuery {
  q?: string;
  category?: string;
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

function validationError(reply: FastifyReply, code: string, message: string) {
  return reply.code(400).send(errorResponse(code, message));
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

function defaultOrgId(): string {
  return "default-org";
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

    if (part.fieldname === "documentType") {
      upload.documentType = value;
      continue;
    }

    if (part.fieldname === "sourceSystem") {
      upload.sourceSystem = value;
      continue;
    }

    if (part.fieldname === "sourceTime") {
      upload.sourceTime = value;
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

function parseSourceTime(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const sourceTime = new Date(value);

  if (Number.isNaN(sourceTime.getTime())) {
    throw new Error("Invalid sourceTime.");
  }

  return sourceTime;
}

function documentStatusResponse(document: DocumentStatusRecord) {
  return {
    id: document.id,
    title: document.title,
    documentType: document.documentType,
    status: document.status,
    labels: document.labels,
    storageObjectKey: document.storageObjectKey,
    originalFileName: document.originalFileName,
    sourceSystem: document.sourceSystem,
    sourceTime: document.sourceTime?.toISOString() ?? null,
    processingRunStatus: document.processingRunStatus
  };
}

function documentQueryResponse(document: DocumentQueryRecord) {
  return {
    id: document.id,
    title: document.title,
    documentType: document.documentType,
    status: document.status,
    labels: document.labels,
    originalFileName: document.originalFileName,
    sourceSystem: document.sourceSystem,
    sourceTime: document.sourceTime?.toISOString() ?? null,
    createdAt: document.createdAt.toISOString()
  };
}

function documentDetailResponse(document: DocumentQueryRecord) {
  return {
    ...documentQueryResponse(document),
    storageObjectKey: document.storageObjectKey,
    contentType: document.contentType,
    byteSize: document.byteSize,
    checksumSha256: document.checksumSha256
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

function parseLabelKeysFromBody(body: DocumentLabelsBody): string[] | null {
  if (!Array.isArray(body.labelKeys)) {
    return null;
  }

  const labelKeys = body.labelKeys
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (labelKeys.length !== body.labelKeys.length) {
    return null;
  }

  return uniqueSorted(labelKeys);
}

function mergeLabels(requestedLabels: CatalogLabel[], personalLabel: CatalogLabel | null) {
  const labelsByKey = new Map(requestedLabels.map((label) => [label.key, label]));

  if (personalLabel) {
    labelsByKey.set(personalLabel.key, personalLabel);
  }

  return [...labelsByKey.values()].sort((first, second) => first.key.localeCompare(second.key));
}

function employeeCanSeeDocumentRecord(
  employee: AuthenticatedEmployee,
  document: DocumentStatusRecord
) {
  if (employee.role === "admin") {
    return true;
  }

  return canEmployeeAccessDocument({
    employee: {
      disabled: employee.disabled,
      labelKeys: employee.labels
    },
    document: {
      labelKeys: document.labels
    }
  });
}

function employeeCanMutateDocument(
  employee: AuthenticatedEmployee,
  document: DocumentStatusRecord
) {
  return employee.role === "admin" || document.uploaderId === employee.id;
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
  let documentRepository = options.documentRepository;
  let skillRepository = options.skillRepository;
  let storageAdapter = options.storageAdapter;
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
    await documentRepository?.disconnect?.();
    await skillRepository?.disconnect?.();
  });

  void app.register(multipart);

  function documents(): DocumentCatalogRepository {
    documentRepository ??= createPrismaDocumentCatalogRepository();
    return documentRepository;
  }

  function storage(): StorageAdapter {
    storageAdapter ??= new LocalFileSystemStorageAdapter();
    return storageAdapter;
  }

  function skills(): SkillDirectoryRepository {
    skillRepository ??= createPrismaSkillDirectoryRepository();
    return skillRepository;
  }

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

  app.get("/labels", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const labels = await documents().listLabels(defaultOrgId());

    return {
      labels: labels.map(labelCatalogResponse)
    };
  });

  app.get<{ Querystring: SkillListQuery }>("/skills", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const query = request.query;
    const skillEntries = await skills().listApprovedSkills({
      orgId: defaultOrgId(),
      q: query.q?.trim() || null,
      category: query.category?.trim() || null
    });

    return {
      skills: skillEntries.map(skillDirectoryResponse)
    };
  });

  app.post("/documents", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    let upload: ParsedUpload;

    try {
      upload = await parseUpload(request);
    } catch {
      return validationError(reply, "INVALID_DOCUMENT_UPLOAD", "Multipart upload is invalid.");
    }

    if (!upload.file) {
      return validationError(reply, "INVALID_DOCUMENT_UPLOAD", "File is required.");
    }

    if (!upload.title) {
      return validationError(reply, "INVALID_DOCUMENT_UPLOAD", "Title is required.");
    }

    if (!upload.documentType || !isDocumentType(upload.documentType)) {
      return validationError(reply, "INVALID_DOCUMENT_UPLOAD", "Document type is invalid.");
    }

    let sourceTime: Date | null;

    try {
      sourceTime = parseSourceTime(upload.sourceTime);
    } catch {
      return validationError(reply, "INVALID_DOCUMENT_UPLOAD", "Source time is invalid.");
    }

    const employee = (request as AuthenticatedRequest).employee;
    const orgId = defaultOrgId();
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
    const documentType: DocumentTypeName = upload.documentType;

    let document: DocumentStatusRecord;

    try {
      document = await documents().createUploadedDocument({
        id: documentId,
        orgId,
        title: upload.title,
        documentType,
        status: "pending_processing",
        storageObjectKey: storedObject.key,
        originalFileName: upload.file.fileName,
        contentType: storedObject.contentType,
        byteSize: storedObject.size,
        checksumSha256: storedObject.hash,
        uploaderId: employee.id,
        sourceSystem: upload.sourceSystem || null,
        sourceTime,
        labelIds: finalLabels.map((label) => label.id),
        labels: finalLabels.map((label) => label.key),
        requestId: request.id,
        clientIp: request.ip
      });
    } catch (error) {
      await storage().deleteObject(storedObject.key);
      request.log.error({ err: error, documentId }, "document catalog write failed");
      return reply
        .code(500)
        .send(errorResponse("DOCUMENT_CATALOG_WRITE_FAILED", "Document catalog write failed."));
    }

    return reply.code(201).send(documentStatusResponse(document));
  });

  app.get<{ Querystring: DocumentListQuery }>("/documents", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const query = request.query;
    const rawDocumentType = query.documentType?.trim() || null;

    if (rawDocumentType && !isDocumentType(rawDocumentType)) {
      return validationError(reply, "INVALID_DOCUMENT_QUERY", "Document type is invalid.");
    }

    const documentType = rawDocumentType as DocumentTypeName | null;

    let limit: number;
    let cursor: string | null;

    try {
      limit = parseLimit(query.limit);
      cursor = parseCursor(query.cursor);
    } catch {
      return validationError(reply, "INVALID_DOCUMENT_QUERY", "Query pagination is invalid.");
    }

    const employee = (request as AuthenticatedRequest).employee;
    const result = await documents().listAccessibleActiveDocuments({
      orgId: defaultOrgId(),
      employee,
      q: query.q?.trim() || null,
      documentType,
      labelKey: query.labelKey?.trim() || null,
      limit,
      cursor
    });

    await documents().appendDocumentQueryAudit({
      orgId: defaultOrgId(),
      employeeId: employee.id,
      q: query.q?.trim() || null,
      documentType,
      labelKey: query.labelKey?.trim() || null,
      resultCount: result.documents.length,
      requestId: request.id,
      clientIp: request.ip
    });

    return {
      documents: result.documents.map(documentQueryResponse),
      nextCursor: result.nextCursor
    };
  });

  app.get<{ Params: { id: string } }>("/documents/:id/status", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;
    const document = await documents().findDocumentStatus(defaultOrgId(), request.params.id);

    if (!document) {
      return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
    }

    if (document.uploaderId !== employee.id && employee.role !== "admin") {
      return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
    }

    return documentStatusResponse(document);
  });

  app.post<{ Params: { id: string } }>("/documents/:id/archive", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;
    const document = await documents().findDocumentStatus(defaultOrgId(), request.params.id);

    if (!document || document.status !== "active") {
      return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
    }

    if (!employeeCanMutateDocument(employee, document)) {
      if (!employeeCanSeeDocumentRecord(employee, document)) {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      return reply
        .code(403)
        .send(errorResponse("DOCUMENT_UPDATE_FORBIDDEN", "Document cannot be changed."));
    }

    const archivedDocument = await documents().archiveDocument({
      orgId: defaultOrgId(),
      documentId: document.id,
      actorEmployeeId: employee.id,
      requestId: request.id,
      clientIp: request.ip
    });

    if (!archivedDocument) {
      return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
    }

    return documentDetailResponse(archivedDocument);
  });

  app.post<{ Body: DocumentLabelsBody; Params: { id: string } }>(
    "/documents/:id/labels",
    async (request, reply) => {
      const authenticated = await authenticate(request, reply, repository, jwtSecret);

      if (!authenticated) {
        return;
      }

      const labelKeys = parseLabelKeysFromBody(request.body);

      if (!labelKeys || labelKeys.length === 0) {
        return validationError(
          reply,
          "INVALID_LABEL_CHANGE",
          "labelKeys must be a non-empty array."
        );
      }

      const employee = (request as AuthenticatedRequest).employee;
      const document = await documents().findDocumentStatus(defaultOrgId(), request.params.id);

      if (!document || document.status !== "active") {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      if (!employeeCanMutateDocument(employee, document)) {
        if (!employeeCanSeeDocumentRecord(employee, document)) {
          return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
        }

        return reply
          .code(403)
          .send(errorResponse("DOCUMENT_UPDATE_FORBIDDEN", "Document cannot be changed."));
      }

      const labels = await documents().findLabelsByKeys(defaultOrgId(), labelKeys);
      const foundLabelKeys = new Set(labels.map((label) => label.key));
      const missingLabelKeys = labelKeys.filter((labelKey) => !foundLabelKeys.has(labelKey));

      if (missingLabelKeys.length > 0) {
        return validationError(reply, "UNKNOWN_LABEL", "One or more labels do not exist.");
      }

      if (employee.role !== "admin" && labels.some((label) => label.type === "all_staff")) {
        return reply
          .code(403)
          .send(errorResponse("FORBIDDEN_LABEL", "One or more labels cannot be assigned."));
      }

      const updatedDocument = await documents().addDocumentLabels({
        orgId: defaultOrgId(),
        documentId: document.id,
        actorEmployeeId: employee.id,
        labelIds: labels.map((label) => label.id),
        labelKeys: labels.map((label) => label.key).sort(),
        requestId: request.id,
        clientIp: request.ip
      });

      if (!updatedDocument) {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      return documentDetailResponse(updatedDocument);
    }
  );

  app.get<{ Params: { id: string } }>("/documents/:id/download", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const employee = (request as AuthenticatedRequest).employee;
    const document = await documents().findAccessibleActiveDocument(
      defaultOrgId(),
      request.params.id,
      employee
    );

    if (!document) {
      return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
    }

    const downloadUrl = await storage().createDownloadUrl(document.storageObjectKey);

    await documents().appendDocumentDownloadAudit({
      orgId: defaultOrgId(),
      employeeId: employee.id,
      documentId: document.id,
      requestId: request.id,
      clientIp: request.ip
    });

    return {
      id: document.id,
      downloadUrl
    };
  });

  app.get<{ Params: { id: string } }>("/documents/:id", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

    if (!authenticated) {
      return;
    }

    const document = await documents().findAccessibleActiveDocument(
      defaultOrgId(),
      request.params.id,
      (request as AuthenticatedRequest).employee
    );

    if (!document) {
      return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
    }

    return documentDetailResponse(document);
  });

  app.get<{ Querystring: AuditListQuery }>("/audit", async (request, reply) => {
    const authenticated = await authenticate(request, reply, repository, jwtSecret);

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
      orgId: defaultOrgId(),
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
