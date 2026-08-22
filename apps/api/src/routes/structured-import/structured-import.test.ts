import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import { AUDIT_ACTIONS, getStructuredRegistry } from "@enterprise-hub/domain";
import { LocalFileSystemStorageAdapter, type StorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "../../server.js";
import {
  adminEmployee,
  baoliManagerEmployee,
  disabledEmployee,
  labelLessEmployee,
  orgBAdminEmployee,
  suzhouManagerEmployee,
  unlabeledAdminEmployee,
  accessTokenFor,
  authenticateTestAccessToken,
  createDocumentRepository,
  createInMemoryStructuredImportRepository,
  createRepository,
  createStructuredImportMultipart,
  jwtSecret,
  storedObjectCount,
  structuredWorkbook,
  validStructuredCsv
} from "../../test-support/api-server-fixtures.js";

describe("structured imports", () => {
  let app: FastifyInstance | undefined;
  let storageRoot: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;

    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
      storageRoot = undefined;
    }
  });

  async function buildStructuredImportTestServer(
    employees: AuthenticatedEmployee[] = [adminEmployee, baoliManagerEmployee],
    options: {
      runtimeEnv?: NodeJS.ProcessEnv;
      storageAdapter?: StorageAdapter;
      failStoragePuts?: number;
    } = {}
  ) {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-import-"));
    const documentRepository = createDocumentRepository();
    const structuredImportRepository = createInMemoryStructuredImportRepository(
      documentRepository.documents,
      documentRepository.auditLogs
    );
    const localStorage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    let storagePutCalls = 0;
    const delegateStorage = options.storageAdapter ?? localStorage;
    let remainingStorageFailures = options.failStoragePuts ?? 0;
    const storageAdapter: StorageAdapter = {
      async putObject(input) {
        storagePutCalls++;
        if (remainingStorageFailures > 0) {
          remainingStorageFailures--;
          throw new Error("simulated storage failure");
        }
        return delegateStorage.putObject(input);
      },
      getObjectStream: delegateStorage.getObjectStream.bind(delegateStorage),
      statObject: delegateStorage.statObject.bind(delegateStorage),
      createDownloadUrl: delegateStorage.createDownloadUrl.bind(delegateStorage),
      deleteObject: delegateStorage.deleteObject.bind(delegateStorage)
    };

    app = buildApiServer({
      employeeRepository: createRepository(employees),
      documentRepository,
      structuredImportRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      runtimeEnv: options.runtimeEnv
    } as Parameters<typeof buildApiServer>[0] & {
      structuredImportRepository: unknown;
    });

    return {
      app,
      documentRepository,
      structuredImportRepository,
      storagePutCalls: () => storagePutCalls
    };
  }

  async function postStructuredImport(
    server: FastifyInstance,
    input: Parameters<typeof createStructuredImportMultipart>[0] = {},
    employee: AuthenticatedEmployee = baoliManagerEmployee
  ) {
    const multipartBody = createStructuredImportMultipart(input);

    return server.inject({
      method: "POST",
      url: "/v1/structured/imports",
      headers: {
        authorization: `Bearer ${await accessTokenFor(employee)}`,
        "x-request-id": "req_http_1",
        "content-type": multipartBody.contentType
      },
      remoteAddress: "198.51.100.8",
      payload: multipartBody.body
    });
  }

  it("accepts unrecognized headers as a queued import without inserting business rows", async () => {
    const { app, documentRepository, structuredImportRepository } =
      await buildStructuredImportTestServer();

    const response = await postStructuredImport(app, {
      idempotencyKey: "queued-invalid-header",
      body: Buffer.from("unrecognized_header\nvalue\n", "utf8")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      document: { status: "pending_processing" },
      processing: { processingRunId: expect.any(String), status: "queued" },
      importBatch: {
        status: "pending",
        sourceSheetSummary: [],
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false,
        totalRowCount: 0,
        appliedRowCount: 0,
        queryableRowCount: 0
      }
    });
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(0);
  });

  it("queues valid CSV imports with canonical storage names", async () => {
    const { app, documentRepository, structuredImportRepository } =
      await buildStructuredImportTestServer();

    const response = await postStructuredImport(app, {
      enterpriseName: "保利店",
      dataset: "dishes",
      idempotencyKey: "csv-success"
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      document: {
        documentKind: "structured",
        fileType: "csv",
        status: "pending_processing",
        originalFileName: "original-dishes.csv"
      },
      importBatch: {
        dataset: "dishes",
        status: "pending",
        startDate: "20260701",
        endDate: "20260705",
        appliedRowCount: 0,
        totalRowCount: 0
      }
    });
    expect(response.json().document.storageObjectKey).toContain(
      "u4fdd_u5229_u5e97_dishes_20260701_20260705.csv"
    );
    expect(documentRepository.documents[0]).toMatchObject({
      status: "pending_processing",
      documentType: "structured_dataset",
      originalFileName: "original-dishes.csv"
    });
    expect(structuredImportRepository.queryableRowCount("dishes")).toBe(0);
    expect(documentRepository.auditLogs).toEqual([
      expect.objectContaining({
        action: "structured_import.started",
        actorEmployeeId: baoliManagerEmployee.id,
        targetType: "import_batch",
        result: "succeeded",
        requestId: "req_http_1",
        clientIp: "198.51.100.8",
        clientSource: "http_api",
        launcherVersion: null,
        metadata: {
          dataset: "dishes",
          startDate: "20260701",
          endDate: "20260705",
          rowCount: 0,
          sourceDocumentId: response.json().document.documentId
        }
      })
    ]);
    expect(JSON.stringify(documentRepository.auditLogs)).not.toContain("value_1");
    expect(JSON.stringify(documentRepository.auditLogs)).not.toContain("保利店_dishes");
  });

  it("queues a catalog snapshot with its dedicated public date and canonical filename", async () => {
    const { app, structuredImportRepository } = await buildStructuredImportTestServer();

    const response = await postStructuredImport(app, {
      dataset: "dish_catalog",
      enterpriseName: "麦家",
      startDate: null,
      endDate: null,
      snapshotDate: "20260819",
      idempotencyKey: "catalog-20260819",
      fileName: "catalog.csv",
      body: Buffer.from(validStructuredCsv("dish_catalog"), "utf8")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().importBatch).toMatchObject({
      dataset: "dish_catalog",
      snapshotDate: "20260819",
      status: "pending"
    });
    expect(response.json().importBatch).not.toHaveProperty("startDate");
    expect(response.json().importBatch).not.toHaveProperty("endDate");
    expect(response.json().document.storageObjectKey).toContain(
      "u9ea6_u5bb6_dish_catalog_20260819.csv"
    );
    expect(structuredImportRepository.batches[0]).toMatchObject({
      dataset: "dish_catalog",
      startDate: "20260819",
      endDate: "20260819"
    });
  });

  it.each([
    {
      name: "catalog without snapshotDate",
      input: { dataset: "dish_catalog" as const, startDate: null, endDate: null }
    },
    {
      name: "catalog with startDate",
      input: {
        dataset: "dish_catalog" as const,
        startDate: "20260819",
        endDate: null,
        snapshotDate: "20260819"
      }
    },
    {
      name: "catalog with endDate",
      input: {
        dataset: "dish_catalog" as const,
        startDate: null,
        endDate: "20260819",
        snapshotDate: "20260819"
      }
    },
    {
      name: "window dataset with snapshotDate",
      input: { dataset: "dishes" as const, snapshotDate: "20260819" }
    }
  ])("rejects invalid conditional date metadata for $name", async ({ name, input }) => {
    const { app, documentRepository, storagePutCalls } = await buildStructuredImportTestServer();
    const response = await postStructuredImport(app, {
      ...input,
      idempotencyKey: `invalid-date-${name}`
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_DATE_WINDOW" } });
    expect(storagePutCalls()).toBe(0);
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("preserves catalog same-snapshot claims while accepting out-of-order snapshots", async () => {
    const { app } = await buildStructuredImportTestServer();
    const uploadCatalog = (snapshotDate: string, idempotencyKey: string) =>
      postStructuredImport(app, {
        dataset: "dish_catalog",
        startDate: null,
        endDate: null,
        snapshotDate,
        idempotencyKey,
        fileName: "catalog.csv",
        body: Buffer.from(validStructuredCsv("dish_catalog"), "utf8")
      });

    const newer = await uploadCatalog("20260820", "catalog-newer");
    const older = await uploadCatalog("20260819", "catalog-older");
    const duplicate = await uploadCatalog("20260820", "catalog-duplicate");

    expect(newer.statusCode).toBe(202);
    expect(older.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "IMPORT_IN_PROGRESS" } });
  });

  it("accepts structured upload metadata exactly at the public string boundaries", async () => {
    const { app, documentRepository } = await buildStructuredImportTestServer();
    const response = await postStructuredImport(app, {
      enterpriseName: "e".repeat(255),
      idempotencyKey: "i".repeat(255),
      fileName: `${"f".repeat(251)}.csv`
    });

    expect(response.statusCode).toBe(202);
    expect(documentRepository.documents[0]).toMatchObject({
      originalFileName: `${"f".repeat(251)}.csv`
    });
  });

  it.each([
    {
      name: "enterprise name",
      input: { enterpriseName: "e".repeat(256), idempotencyKey: "enterprise-too-long" }
    },
    {
      name: "idempotency key",
      input: { idempotencyKey: "i".repeat(256) }
    },
    {
      name: "filename",
      input: { fileName: `${"f".repeat(252)}.csv`, idempotencyKey: "filename-too-long" }
    },
    {
      name: "label key",
      input: { labelKeys: ["l".repeat(129)], idempotencyKey: "label-too-long" }
    },
    {
      name: "label count",
      input: {
        labelKeys: Array.from({ length: 51 }, (_, index) => `label_${index}`),
        idempotencyKey: "labels-too-many"
      }
    }
  ])("rejects structured upload $name above the public boundary", async ({ input }) => {
    const { app, documentRepository, storagePutCalls } = await buildStructuredImportTestServer();
    const response = await postStructuredImport(app, input);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_STRUCTURED_IMPORT_UPLOAD" }
    });
    expect(storagePutCalls()).toBe(0);
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("defers XLSX header discovery until worker processing", async () => {
    const { app } = await buildStructuredImportTestServer();

    const response = await postStructuredImport(app, {
      enterpriseName: "麦家",
      dataset: "dishes",
      idempotencyKey: "xlsx-preface-success",
      fileName: "麦家菜品记录.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await structuredWorkbook({
        dataset: "dishes",
        prefaceRows: [["菜品主题数据"], ["统计时间：2026-07-01 至 2026-07-05"]]
      })
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      importBatch: {
        dataset: "dishes",
        status: "pending",
        appliedRowCount: 0,
        sourceSheetSummary: []
      }
    });
  });

  it("defers structured summary parsing until worker processing", async () => {
    const { app, structuredImportRepository } = await buildStructuredImportTestServer();
    const registry = getStructuredRegistry("business");
    const footer = ["合计", ...registry.fields.slice(1).map(() => "--")].join(",");

    const response = await postStructuredImport(app, {
      enterpriseName: "麦家",
      dataset: "business",
      idempotencyKey: "csv-summary-footer-success",
      fileName: "business.csv",
      contentType: "text/csv",
      body: Buffer.from(`${validStructuredCsv("business")}${footer}\n`, "utf8")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      importBatch: {
        dataset: "business",
        status: "pending",
        appliedRowCount: 0,
        totalRowCount: 0
      }
    });
    expect(structuredImportRepository.queryableRowCount("business")).toBe(0);
  });

  it("handles import idempotency and active/in-progress window conflicts", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();

    const firstResponse = await postStructuredImport(app, {
      idempotencyKey: "stable-key"
    });
    const replayResponse = await postStructuredImport(app, {
      idempotencyKey: "stable-key"
    });
    const conflictResponse = await postStructuredImport(app, {
      idempotencyKey: "stable-key",
      body: Buffer.from(validStructuredCsv("dishes", { business_date: "2026-07-03" }), "utf8")
    });
    const activeWindowResponse = await postStructuredImport(app, {
      idempotencyKey: "new-key-same-window"
    });

    structuredImportRepository.markWindowInProgress({
      dataset: "business",
      startDate: "20260701",
      endDate: "20260705"
    });
    const inProgressWindowResponse = await postStructuredImport(app, {
      dataset: "business",
      idempotencyKey: "business-window",
      body: Buffer.from(validStructuredCsv("business"), "utf8")
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(replayResponse.statusCode).toBe(202);
    expect(replayResponse.json().importBatch.importBatchId).toBe(
      firstResponse.json().importBatch.importBatchId
    );
    expect(replayResponse.json().document).toEqual(firstResponse.json().document);
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_CONFLICT" }
    });
    expect(activeWindowResponse.statusCode).toBe(409);
    expect(activeWindowResponse.json()).toMatchObject({
      error: { code: "IMPORT_IN_PROGRESS" }
    });
    expect(inProgressWindowResponse.statusCode).toBe(409);
    expect(inProgressWindowResponse.json()).toMatchObject({
      error: { code: "IMPORT_IN_PROGRESS" }
    });
    expect(storagePutCalls()).toBe(1);
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(0);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportStarted
      )
    ).toHaveLength(1);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportApplied
      )
    ).toHaveLength(0);
  });

  it("reuses the reserved document and object key after a transient storage failure", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer(undefined, { failStoragePuts: 1 });

    const first = await postStructuredImport(app, { idempotencyKey: "storage-recovery" });
    expect(first.statusCode).toBe(500);
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]?.status).toBe("uploading");
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.batches[0]?.status).toBe("pending");
    expect(structuredImportRepository.rows).toHaveLength(0);

    const replay = await postStructuredImport(app, { idempotencyKey: "storage-recovery" });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().document.documentId).toBe(documentRepository.documents[0]?.id);
    expect(replay.json().document.storageObjectKey).toBe(
      documentRepository.documents[0]?.storageObjectKey
    );
    expect(storagePutCalls()).toBe(2);
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(0);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportStarted
      )
    ).toHaveLength(1);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportApplied
      )
    ).toHaveLength(0);
  });

  it("recovers a stored object when queue publication fails before a processing run exists", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();
    structuredImportRepository.failNextEnqueue("simulated queue publication failure");

    const first = await postStructuredImport(app, { idempotencyKey: "queue-recovery" });
    expect(first.statusCode).toBe(500);
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]?.status).toBe("uploading");
    expect(structuredImportRepository.batches[0]?.status).toBe("pending");
    expect(structuredImportRepository.rows).toHaveLength(0);
    expect(await storedObjectCount(storageRoot)).toBe(1);

    const replay = await postStructuredImport(app, { idempotencyKey: "queue-recovery" });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().document.documentId).toBe(documentRepository.documents[0]?.id);
    expect(storagePutCalls()).toBe(2);
    expect(await storedObjectCount(storageRoot)).toBe(1);
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(0);
  });

  it("allows a new idempotency key after a rejected import releases its date window", async () => {
    const { app, documentRepository, structuredImportRepository } =
      await buildStructuredImportTestServer();

    const rejected = await postStructuredImport(app, { idempotencyKey: "terminal-window-first" });
    structuredImportRepository.batches[0]!.status = "rejected";
    documentRepository.documents[0]!.status = "processing_failed";

    const replacement = await postStructuredImport(app, {
      idempotencyKey: "terminal-window-replacement"
    });

    expect(rejected.statusCode).toBe(202);
    expect(replacement.statusCode).toBe(202);
    expect(replacement.json()).toMatchObject({
      document: { status: "pending_processing" },
      processing: { status: "queued" },
      importBatch: { status: "pending" }
    });
    expect(structuredImportRepository.batches).toHaveLength(2);
  });

  it("accepts worker-validated header and worksheet errors without exposing rows", async () => {
    const { app, structuredImportRepository } = await buildStructuredImportTestServer();

    const invalidCsvResponse = await postStructuredImport(app, {
      idempotencyKey: "invalid-csv",
      body: Buffer.from("未知列\nbad\n", "utf8")
    });
    const hiddenSheetResponse = await postStructuredImport(app, {
      idempotencyKey: "hidden-sheet",
      startDate: "20260706",
      endDate: "20260710",
      fileName: "hidden.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await structuredWorkbook({ dataset: "dishes", includeHiddenSheet: true })
    });
    const explanationSheetResponse = await postStructuredImport(app, {
      idempotencyKey: "explanation-sheet",
      startDate: "20260711",
      endDate: "20260715",
      fileName: "explanation.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await structuredWorkbook({ dataset: "dishes", includeExplanationSheet: true })
    });

    for (const response of [invalidCsvResponse, hiddenSheetResponse, explanationSheetResponse]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        processing: { status: "queued" },
        importBatch: { status: "pending", validationErrors: [], totalRowCount: 0 }
      });
    }
    expect(structuredImportRepository.queryableRowCount("dishes")).toBe(0);
  });

  it("keeps costly row and workbook limits out of the API acceptance path", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer(undefined, {
        runtimeEnv: {
          MAX_STRUCTURED_IMPORT_ROWS: "1",
          MAX_STRUCTURED_CELL_CHARS: "100"
        } as NodeJS.ProcessEnv
      });
    const validCsvLines = validStructuredCsv("dishes").trim().split("\n");
    const overLimitCsv = Buffer.from(
      `${validCsvLines[0]}\n${validCsvLines[1]}\n${validCsvLines[1]}\n`,
      "utf8"
    );

    const responses = await Promise.all([
      postStructuredImport(app, {
        idempotencyKey: "atomic-malformed-csv",
        body: Buffer.from("unknown\nvalue\n", "utf8")
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-over-limit-csv",
        startDate: "20260706",
        endDate: "20260710",
        body: overLimitCsv
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-long-cell-csv",
        startDate: "20260711",
        endDate: "20260715",
        body: Buffer.from(validStructuredCsv("dishes", { product_name: "x".repeat(101) }), "utf8")
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-malformed-xlsx",
        startDate: "20260716",
        endDate: "20260720",
        fileName: "malformed.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-over-limit-xlsx",
        startDate: "20260721",
        endDate: "20260725",
        fileName: "over-limit.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: await structuredWorkbook({ dataset: "dishes", rowCount: 2 })
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-unevaluated-formula-xlsx",
        startDate: "20260726",
        endDate: "20260730",
        fileName: "unevaluated-formula.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: await structuredWorkbook({
          dataset: "dishes",
          cellOverrides: { product_name: { formula: "1+1" } }
        })
      })
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        document: { status: "pending_processing" },
        processing: { status: "queued" },
        importBatch: { status: "pending", totalRowCount: 0, appliedRowCount: 0 }
      });
    }
    expect(responses[3]?.payload).not.toContain("Malformed XLSX ZIP archive");
    expect(storagePutCalls()).toBe(6);
    expect(documentRepository.documents).toHaveLength(6);
    expect(documentRepository.auditLogs).toHaveLength(6);
    expect(structuredImportRepository.batches).toHaveLength(6);
    expect(structuredImportRepository.rows).toHaveLength(0);
  });

  it("keeps queued imports non-queryable when the source document is archived", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();
    const importResponse = await postStructuredImport(app, {
      idempotencyKey: "archive-rows"
    });
    const documentId = importResponse.json().document.documentId;

    const archivedDocument = await documentRepository.archiveDocument({
      orgId: "default-org",
      documentId,
      actorEmployeeId: baoliManagerEmployee.id,
      audit: {
        requestId: "test-request",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      }
    });
    const statusResponse = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${importResponse.json().importBatch.importBatchId}`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });
    const replayResponse = await postStructuredImport(app, { idempotencyKey: "archive-rows" });

    expect(archivedDocument?.status).toBe("archived");
    expect(structuredImportRepository.storedRowCount("dishes")).toBe(0);
    expect(structuredImportRepository.queryableRowCount("dishes")).toBe(0);
    expect(statusResponse.json()).toMatchObject({
      document: { documentId, status: "archived" },
      processing: { processingRunId: expect.any(String), status: "queued" },
      importBatch: {
        status: "archived",
        totalRowCount: 0,
        queryableRowCount: 0
      }
    });
    expect(replayResponse.statusCode).toBe(202);
    expect(replayResponse.json()).toMatchObject({
      document: { documentId, status: "archived" },
      importBatch: { status: "archived", queryableRowCount: 0 }
    });
    expect(storagePutCalls()).toBe(1);
  });

  it("replaces an archived catalog snapshot with a new key while replaying the original batch", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();
    const originalInput = {
      dataset: "dish_catalog" as const,
      startDate: null,
      endDate: null,
      snapshotDate: "20260819",
      idempotencyKey: "catalog-original",
      fileName: "catalog.csv",
      body: Buffer.from(validStructuredCsv("dish_catalog"), "utf8")
    };
    const original = await postStructuredImport(app, originalInput);
    const originalBatchId = original.json().importBatch.importBatchId;
    const originalDocumentId = original.json().document.documentId;

    await structuredImportRepository.applyReservedStructuredImport({
      orgId: "default-org",
      actorEmployeeId: baoliManagerEmployee.id,
      importBatchId: originalBatchId,
      rows: [],
      audit: {
        requestId: "test-apply",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      }
    });
    await documentRepository.archiveDocument({
      orgId: "default-org",
      documentId: originalDocumentId,
      actorEmployeeId: baoliManagerEmployee.id,
      audit: {
        requestId: "test-archive",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      }
    });

    const replacement = await postStructuredImport(app, {
      ...originalInput,
      idempotencyKey: "catalog-replacement"
    });
    const replay = await postStructuredImport(app, originalInput);

    expect(replacement.statusCode).toBe(202);
    expect(replacement.json()).toMatchObject({
      document: { status: "pending_processing" },
      importBatch: { dataset: "dish_catalog", snapshotDate: "20260819", status: "pending" }
    });
    expect(replacement.json().importBatch.importBatchId).not.toBe(originalBatchId);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      document: { documentId: originalDocumentId, status: "archived" },
      importBatch: { importBatchId: originalBatchId, status: "archived", snapshotDate: "20260819" }
    });
    expect(storagePutCalls()).toBe(2);
  });

  it("returns import status only to same-org callers authorized by source document labels", async () => {
    const { app } = await buildStructuredImportTestServer([
      adminEmployee,
      baoliManagerEmployee,
      suzhouManagerEmployee,
      labelLessEmployee,
      unlabeledAdminEmployee,
      disabledEmployee,
      orgBAdminEmployee
    ]);

    const matchingImport = await postStructuredImport(app, {
      idempotencyKey: "status-matching",
      labelKeys: ["store:baoli"]
    });
    const allStaffImport = await postStructuredImport(
      app,
      {
        idempotencyKey: "status-all-staff",
        dataset: "business",
        body: Buffer.from(validStructuredCsv("business"), "utf8"),
        labelKeys: ["all_staff"]
      },
      adminEmployee
    );
    const matchingBatchId = matchingImport.json().importBatch.importBatchId;
    const allStaffBatchId = allStaffImport.json().importBatch.importBatchId;

    const matching = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}` }
    });
    const allStaff = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${allStaffBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(labelLessEmployee)}` }
    });
    const admin = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(unlabeledAdminEmployee)}` }
    });
    const noMatch = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(suzhouManagerEmployee)}` }
    });
    const disabled = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(disabledEmployee)}` }
    });
    const crossOrg = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(orgBAdminEmployee)}` }
    });

    for (const response of [matching, allStaff, admin]) {
      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.json())).not.toContain("sourceDocumentLabelKeys");
    }
    for (const response of [noMatch, crossOrg]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: "IMPORT_BATCH_NOT_FOUND", message: "Import batch not found." }
      });
      expect(JSON.stringify(response.json())).not.toMatch(
        /dataset|startDate|endDate|totalRowCount|sourceSheetSummary|validationErrors/
      );
    }
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ error: { code: "EMPLOYEE_DISABLED" } });
  });
});
