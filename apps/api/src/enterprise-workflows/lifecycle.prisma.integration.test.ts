import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { createPrismaStructuredImportRepository } from "../structured-imports.js";
import {
  createPrismaProcessingWorkerRepository,
  runWorkerOnce
} from "../../../worker/src/worker.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createBusinessAuthorizationRepository,
  createDatabaseAdapter,
  createPrismaStoreReviewRepository
} from "@smedc/db";
import { workflowCanonicalJson, type AuthenticatedEmployee } from "@smedc/domain";
import { createOwnedIntegrationDatabase } from "../../../../scripts/test-integration-support.js";
import { buildApiServer } from "../server.js";
import { createStoreReviewService } from "../store-reviews.js";
import { createEnterpriseWorkflowService } from "./service.js";

describe.skipIf(process.env["RUN_WORKFLOW_INTEGRATION"] !== "1")(
  "enterprise workflow public lifecycle",
  () => {
    let database: Awaited<ReturnType<typeof createOwnedIntegrationDatabase>>;
    let prisma: PrismaClient;
    let app: ReturnType<typeof buildApiServer>;
    let testClock = new Date();
    let storageRoot: string;
    let storage: LocalFileSystemStorageAdapter;
    const actor: AuthenticatedEmployee = {
      id: "workflow_admin",
      orgId: "workflow_org",
      email: "admin@example.invalid",
      displayName: "Synthetic",
      organizationName: "Synthetic",
      role: "admin",
      disabled: false,
      clearance: 3
    };
    const selector = { enterpriseKey: "enterprise", workflowType: "meituan-daily-ingestion" };
    const configuration = {
      schemaVersion: 1,
      type: selector.workflowType,
      storeNames: ["Store A"],
      notificationPolicy: "action_required",
      datasets: ["business"],
      orderScope: "settled_only",
      cleanupPolicy: "confirmed_files_only"
    };
    const call = async (tool: string, body: unknown) =>
      app.inject({
        method: "POST",
        url: `/v1/admin/workflows/${tool}`,
        headers: { authorization: "Bearer synthetic", "content-type": "application/json" },
        payload: JSON.stringify(body)
      });
    const callMcp = async (name: string, args: unknown, launcherVersion = "0.17.0") => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: {
          host: "127.0.0.1:3000",
          authorization: "Bearer synthetic",
          accept: "application/json, text/event-stream",
          "x-smedc-launcher-version": launcherVersion
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
      });
      expect(response.statusCode, response.body).toBe(200);
      const envelope = response.json();
      expect(envelope.error, response.body).toBeUndefined();
      return envelope.result;
    };
    beforeAll(async () => {
      database = await createOwnedIntegrationDatabase(
        process.env["DATABASE_URL"]!,
        process.env["MYSQL_PORT"]!
      );
      execFileSync(
        "node_modules/.bin/prisma",
        ["migrate", "deploy", "--config", "packages/db/prisma.config.ts"],
        { env: { ...process.env, DATABASE_URL: database.databaseUrl }, stdio: "pipe" }
      );
      prisma = new PrismaClient({ adapter: createDatabaseAdapter(database.databaseUrl) });
      await prisma.organization.create({ data: { id: actor.orgId, name: "Synthetic" } });
      await prisma.employee.create({
        data: {
          id: actor.id,
          orgId: actor.orgId,
          email: actor.email,
          displayName: actor.displayName,
          role: "admin",
          clearance: 3
        }
      });
      await prisma.businessAuthorizationState.create({
        data: { orgId: actor.orgId, mode: "enabled" }
      });
      await prisma.businessEnterpriseIdentity.create({
        data: { orgId: actor.orgId, enterpriseKey: "enterprise", enterpriseName: "enterprise" }
      });
      await prisma.businessStore.create({
        data: { orgId: actor.orgId, enterpriseKey: "enterprise", name: "Store A" }
      });
      storageRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-recovery-"));
      storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
      app = buildApiServer({
        logger: false,
        runtimeEnv: { ...process.env, DATABASE_URL: database.databaseUrl },
        storageAdapter: storage,
        structuredImportRepository: createPrismaStructuredImportRepository({
          databaseUrl: database.databaseUrl,
          transactionTimeoutMs: 15000,
          batchInsertSize: 500
        }),
        cursorSigningSecret: "synthetic-test-secret",
        authenticateAccessToken: async () => actor,
        enterpriseWorkflowService: createEnterpriseWorkflowService({
          prisma,
          now: () => testClock
        }),
        storeReviewService: createStoreReviewService({
          repository: createPrismaStoreReviewRepository({
            prisma,
            cursorSecret: "synthetic-test-secret"
          })
        })
      });
      await app.ready();
    }, 60000);
    afterAll(async () => {
      await app?.close();
      await prisma?.$disconnect();
      await database?.cleanup();
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    });
    it("prepares and atomically saves immutable configuration without activating old upload paths", async () => {
      const discovered = (
        await call("list_enterprise_workflows", { enterpriseKey: "enterprise" })
      ).json();
      expect(discovered).toMatchObject({
        capability: {
          id: "enterprise-workflows-v1",
          version: "1.0.0",
          configurationSchemaVersion: 1,
          minimumLauncherVersion: "0.17.0"
        },
        needsConfiguration: true,
        setupUrl: "/admin/workflow_org/workflows/enterprise"
      });
      const expected = {
        expectedVersion: 0,
        expectedIntegrationVersion: 0,
        expectedControlVersion: 0
      };
      const preview = await call("prepare_enterprise_workflow_change", {
        ...selector,
        ...expected,
        change: { kind: "configuration", configuration }
      });
      expect(preview.statusCode).toBe(200);
      const { previewId, confirmationDigest } = preview.json();
      const saved = await call("save_enterprise_workflow", {
        ...selector,
        ...expected,
        previewId,
        confirmationDigest
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        version: 1,
        controlState: "paused",
        configuration,
        integration: { orderScopeRequired: false }
      });
      expect(
        (await call("get_workflow_status", { workflowId: saved.json().workflowId })).json()
          .possibleMissedWindow
      ).toBe(false);
      const stale = await call("save_enterprise_workflow", {
        ...selector,
        ...expected,
        previewId,
        confirmationDigest
      });
      expect(stale.statusCode).toBe(409);
      expect((await call("get_enterprise_workflow", selector)).json()).toMatchObject({
        version: 1,
        configuration
      });
    });
    it("requires checked installation, explicit assignment and one immutable leased run", async () => {
      const change = async (value: unknown) => {
        const current = (await call("get_enterprise_workflow", selector)).json();
        const expected = {
          expectedVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion
        };
        const preview = (
          await call("prepare_enterprise_workflow_change", {
            ...selector,
            ...expected,
            change: value
          })
        ).json();
        const saved = await call("save_enterprise_workflow", {
          ...selector,
          ...expected,
          previewId: preview.previewId,
          confirmationDigest: preview.confirmationDigest
        });
        expect(saved.statusCode).toBe(200);
        return saved.json();
      };
      let current = await change({
        kind: "integration",
        configuration: {
          schemaVersion: 1,
          timezone: "Asia/Shanghai",
          sourceAccounts: [
            {
              product: "meituan_erp",
              accountRef: "source",
              displayName: "Synthetic",
              sourceEnterpriseName: "Synthetic"
            }
          ],
          storeMappings: [
            {
              storeName: "Store A",
              source: {
                product: "meituan_erp",
                channel: "erp",
                accountRef: "source",
                sourceStoreId: "poi",
                sourceStoreName: "Source Store"
              }
            }
          ],
          exclusions: []
        }
      });
      current = await change({
        kind: "authorization",
        grant: [{ kind: "upload", datasets: ["business"], storeNames: ["Store A"] }],
        revokeAuthorizationIds: []
      });
      current = await change({ kind: "control", state: "active", reason: "Synthetic activation" });
      const workflowId = current.workflowId;
      const install = (operation: unknown) =>
        call("manage_workflow_installation", { workflowId, operation });
      const installation = {
        installationId: "mac-a",
        deviceAlias: "Synthetic Mac",
        host: "codex",
        platform: "macos",
        launcherVersion: "0.16.0",
        workflowPackageVersion: "1.0.3"
      };
      expect((await install({ kind: "register", installation })).statusCode).toBe(200);
      expect((await install({ kind: "register", installation })).json()).toMatchObject({
        installationId: "mac-a",
        version: 1
      });
      const hostSnapshot = {
        host: "codex",
        platform: "macos",
        taskId: "task",
        projectRef: "project",
        cron: "45 3 * * *",
        timezone: "Asia/Shanghai",
        model: "available-model",
        reasoningEffort: "high",
        state: "paused",
        verifiedAt: new Date().toISOString()
      };
      expect(
        (await install({ kind: "record_host", installationId: "mac-a", hostSnapshot })).statusCode
      ).toBe(200);
      const checks = [
        "configuration",
        "permissions",
        "workspace",
        "dependencies",
        "host_schedule",
        "host_timezone",
        "host_model",
        "download",
        "meituan_erp"
      ].map((capability) => ({
        capability,
        status: "ready",
        nextStep: "",
        checkedAt: new Date().toISOString()
      }));
      expect(
        (
          await install({
            kind: "record_checks",
            installationId: "mac-a",
            checks,
            firstRunVerification: "not_run"
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await install({
            kind: "record_checks",
            installationId: "mac-a",
            checks,
            firstRunVerification: "verified"
          })
        ).statusCode
      ).toBe(409);
      for (const version of ["1.1.0", "2.0.0", "1.0.3-rc.1"]) {
        await install({
          kind: "register",
          installation: { ...installation, workflowPackageVersion: version }
        });
        const rejected = await install({
          kind: "prepare_takeover",
          installationId: "mac-a",
          expectedAssignmentEpoch: 0,
          oldHostState: "paused"
        });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json().error.code).toBe("WORKFLOW_VERSION_INCOMPATIBLE");
      }
      await install({ kind: "register", installation });
      await install({
        kind: "record_checks",
        installationId: "mac-a",
        checks,
        firstRunVerification: "not_run"
      });
      const takeover = await install({
        kind: "prepare_takeover",
        installationId: "mac-a",
        expectedAssignmentEpoch: 0,
        oldHostState: "paused"
      });
      expect(takeover.statusCode, takeover.body).toBe(200);
      expect(
        (
          await install({
            kind: "takeover",
            installationId: "mac-a",
            expectedAssignmentEpoch: 0,
            previewId: takeover.json().previewId,
            confirmationDigest: takeover.json().confirmationDigest
          })
        ).statusCode
      ).toBe(200);
      expect((await call("get_workflow_status", { workflowId })).json().possibleMissedWindow).toBe(
        false
      );
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
        new Date()
      );
      const previous = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
        .toISOString()
        .slice(0, 10);
      const start = {
        kind: "start",
        installationId: "mac-a",
        assignmentEpoch: 1,
        expectedConfigurationVersion: 1,
        expectedIntegrationVersion: current.integration.version,
        expectedControlVersion: current.controlVersion,
        workflowPackageVersion: "1.0.3",
        window: { startDate: previous, endDate: previous },
        mode: "scheduled"
      };
      const mismatched = await call("manage_workflow_run", {
        workflowId,
        operation: { ...start, workflowPackageVersion: "1.0.2" }
      });
      expect(mismatched.statusCode).toBe(409);
      expect(mismatched.json().error.code).toBe("WORKFLOW_VERSION_INCOMPATIBLE");
      const racing = await Promise.all([
        call("manage_workflow_run", { workflowId, operation: start }),
        call("manage_workflow_run", { workflowId, operation: start })
      ]);
      expect(racing.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const run = racing.find((response) => response.statusCode === 200)!;
      expect(run.json()).toMatchObject({
        snapshot: { configurationVersion: 1, configuration, workflowPackageVersion: "1.0.3" },
        assignmentEpoch: 1
      });
      expect((await call("manage_workflow_run", { workflowId, operation: start })).statusCode).toBe(
        409
      );
      await install({
        kind: "register",
        installation: { ...installation, workflowPackageVersion: "1.0.4" }
      });
      const changedPackage = await call("manage_workflow_run", {
        workflowId,
        operation: {
          kind: "renew",
          installationId: "mac-a",
          runId: run.json().runId,
          assignmentEpoch: 1,
          controlVersion: current.controlVersion
        }
      });
      expect(changedPackage.statusCode).toBe(409);
      expect(changedPackage.json().error.code).toBe("WORKFLOW_VERSION_INCOMPATIBLE");
      await install({ kind: "register", installation });
      await install({
        kind: "record_checks",
        installationId: "mac-a",
        checks,
        firstRunVerification: "not_run"
      });
      await change({
        kind: "configuration",
        configuration: { ...configuration, datasets: ["business", "dishes"] }
      });
      const status = await call("get_workflow_status", { workflowId, runId: run.json().runId });
      expect(status.statusCode).toBe(200);
      expect(status.json().runs[0].snapshot.configuration.datasets).toEqual(["business"]);
    });

    it("records intent before external work, preserves unknown, and rejects revoked actors", async () => {
      const state = (await call("get_enterprise_workflow", selector)).json();
      const status = (await call("get_workflow_status", { workflowId: state.workflowId })).json();
      const run = status.runs[0];
      const binding = {
        installationId: run.installationId,
        runId: run.runId,
        assignmentEpoch: run.assignmentEpoch,
        controlVersion: state.controlVersion
      };
      const intent = {
        actionId: "upload-action",
        identity: {
          kind: "upload",
          dataset: "business",
          storeNames: ["Store A"],
          window: run.snapshot.window,
          sourceHash: "a".repeat(64),
          metadataHash: "b".repeat(64)
        }
      };
      const action = (operation: unknown) =>
        call("record_workflow_action", { workflowId: state.workflowId, operation });
      const first = await action({ kind: "intent", ...binding, actions: [intent] });
      expect(first.statusCode).toBe(200);
      expect(first.json().actions).toMatchObject([
        { actionId: "upload-action", state: "intent", permitted: true }
      ]);
      expect(
        (await action({ kind: "intent", ...binding, actions: [intent] })).json().actions
      ).toMatchObject([{ actionId: "upload-action", permitted: false }]);
      const receipt = {
        actionId: "upload-action",
        state: "unknown",
        evidence: "transport_unknown",
        verifiedAt: new Date().toISOString()
      };
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [receipt] })).statusCode
      ).toBe(200);
      expect(
        (
          await action({
            kind: "intent",
            ...binding,
            actions: [{ ...intent, actionId: "different-task-id" }]
          })
        ).json().actions
      ).toMatchObject([{ actionId: "upload-action", state: "unknown", permitted: false }]);
      const invalid = await action({
        kind: "resolve_unknown",
        ...binding,
        receipt: {
          actionId: "upload-action",
          state: "confirmed",
          evidence: "service_status",
          jobId: "missing-or-accepted-job",
          verifiedAt: new Date().toISOString()
        }
      });
      expect(invalid.statusCode).toBe(409);
      expect(
        (
          await action({
            kind: "resolve_unknown",
            ...binding,
            receipt: {
              actionId: "upload-action",
              state: "confirmed",
              evidence: "manual_resolution",
              receiptId: "verified-receipt",
              reason: "Administrator matched complete published result",
              verifiedAt: new Date().toISOString()
            }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (await action({ kind: "get", actionIds: ["upload-action"] })).json().actions[0].state
      ).toBe("confirmed");
      const acceptedIntent = {
        actionId: "accepted-upload",
        identity: { ...intent.identity, sourceHash: "d".repeat(64) }
      };
      await action({ kind: "intent", ...binding, actions: [acceptedIntent] });
      await prisma.partitionImportJob.create({
        data: {
          id: "synthetic_import_job",
          orgId: actor.orgId,
          uploaderId: actor.id,
          dataset: "business",
          enterpriseKey: "enterprise",
          enterpriseName: "Synthetic",
          confidentialityLevel: 1,
          idempotencyKey: "synthetic-upload-key",
          requestFingerprint: "e".repeat(64),
          originalFileName: "synthetic.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sourceByteSize: 10n,
          sourceChecksumSha256: "d".repeat(64),
          sourceStartDate: new Date(run.snapshot.window.startDate),
          sourceEndDate: new Date(run.snapshot.window.endDate),
          status: "queued",
          expiresAt: new Date(testClock.getTime() + 86400000)
        }
      });
      const publishedReceipt = {
        actionId: "accepted-upload",
        state: "confirmed",
        evidence: "service_status",
        jobId: "synthetic_import_job",
        verifiedAt: testClock.toISOString()
      };
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [publishedReceipt] }))
          .statusCode
      ).toBe(409);
      await prisma.partitionImportJob.update({
        where: { id: "synthetic_import_job" },
        data: { status: "published", publishedAt: testClock, partitionCount: 1, totalRowCount: 1n }
      });
      await prisma.structuredPartition.create({
        data: {
          id: "synthetic_partition",
          orgId: actor.orgId,
          enterpriseKey: "enterprise",
          enterpriseName: "Synthetic",
          dataset: "business",
          storeKey: "Store A",
          storeName: "Store A",
          businessDate: new Date(run.snapshot.window.startDate),
          objectKey: "synthetic/workflow/partition.csv",
          rowCount: 1n,
          byteSize: 10n,
          checksumSha256: "f".repeat(64),
          confidentialityLevel: 1,
          publishedByJobId: "synthetic_import_job"
        }
      });
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [publishedReceipt] }))
          .statusCode
      ).toBe(200);
      // A replacement host knows the run ID, but has none of the local action IDs.
      const recoveryIds = ["cold-failed", "cold-intent", "cold-unknown", "cold-other-run"];
      try {
        for (const [index, actionId] of recoveryIds.slice(0, 3).entries()) {
          expect(
            (
              await action({
                kind: "intent",
                ...binding,
                actions: [
                  {
                    actionId,
                    identity: { ...intent.identity, sourceHash: String(index + 1).repeat(64) }
                  }
                ]
              })
            ).statusCode
          ).toBe(200);
        }
        expect(
          (
            await action({
              kind: "record_receipts",
              ...binding,
              receipts: [
                {
                  actionId: "cold-failed",
                  state: "failed",
                  evidence: "request_rejected",
                  reason: "Synthetic no-commit rejection",
                  verifiedAt: testClock.toISOString()
                },
                {
                  actionId: "cold-unknown",
                  state: "unknown",
                  evidence: "transport_unknown",
                  verifiedAt: testClock.toISOString()
                }
              ]
            })
          ).statusCode
        ).toBe(200);
        await prisma.workflowAction.create({
          data: {
            orgId: actor.orgId,
            workflowId: state.workflowId,
            actionId: "cold-other-run",
            runId: "different-run",
            idempotencyKey: "9".repeat(64),
            identity: { ...intent.identity, sourceHash: "9".repeat(64) },
            state: "confirmed"
          }
        });
        const refs: Array<{ actionId: string; runId: string; state: string }> = [];
        let actionCursor: string | undefined;
        do {
          const page = (
            await call("get_workflow_status", {
              workflowId: state.workflowId,
              runId: run.runId,
              limit: 2,
              ...(actionCursor ? { actionCursor } : {})
            })
          ).json();
          expect(page.runActionRefs).toHaveLength(actionCursor === "cold-unknown" ? 1 : 2);
          for (const ref of page.runActionRefs) {
            expect(Object.keys(ref).sort()).toEqual(["actionId", "runId", "state", "updatedAt"]);
            expect(ref.runId).toBe(run.runId);
            refs.push(ref);
          }
          actionCursor = page.nextRunActionCursor ?? undefined;
        } while (actionCursor);
        expect(refs.map((ref) => [ref.actionId, ref.state])).toEqual([
          ["accepted-upload", "confirmed"],
          ["cold-failed", "failed"],
          ["cold-intent", "intent"],
          ["cold-unknown", "unknown"],
          ["upload-action", "confirmed"]
        ]);
        const recovered = (
          await action({ kind: "get", actionIds: refs.map((ref) => ref.actionId) })
        ).json();
        expect(
          recovered.actions.find(
            (item: { actionId: string }) => item.actionId === "accepted-upload"
          ).receipt.jobId
        ).toBe("synthetic_import_job");
        const ordinaryStatus = (
          await call("get_workflow_status", { workflowId: state.workflowId })
        ).json();
        expect(ordinaryStatus.runActionRefs).toBeUndefined();
        expect(
          ordinaryStatus.pendingActions.every((ref: { state: string }) =>
            ["intent", "unknown"].includes(ref.state)
          )
        ).toBe(true);
        expect(
          (
            await call("get_workflow_status", {
              workflowId: state.workflowId,
              runId: "missing-run"
            })
          ).json().runActionRefs
        ).toEqual([]);
      } finally {
        await prisma.workflowActionDeduplication.deleteMany({
          where: { orgId: actor.orgId, workflowId: state.workflowId, actionId: { in: recoveryIds } }
        });
        await prisma.workflowAction.deleteMany({
          where: { orgId: actor.orgId, workflowId: state.workflowId, actionId: { in: recoveryIds } }
        });
      }
      await prisma.employee.update({ where: { id: actor.id }, data: { role: "employee" } });
      expect((await action({ kind: "get", actionIds: ["upload-action"] })).statusCode).toBe(403);
      expect(
        (await call("get_workflow_status", { workflowId: state.workflowId, runId: run.runId }))
          .statusCode
      ).toBe(403);
      await prisma.employee.update({ where: { id: actor.id }, data: { role: "admin" } });
    });

    it("confirms an actual uploaded delivery receipt using persisted receipt dates and scope", async () => {
      const enterpriseKey = "receipt-enterprise";
      await prisma.businessEnterpriseIdentity.create({
        data: { orgId: actor.orgId, enterpriseKey, enterpriseName: enterpriseKey }
      });
      await prisma.businessStore.create({
        data: { orgId: actor.orgId, enterpriseKey, name: "Store A" }
      });
      await prisma.businessCategory.create({
        data: {
          orgId: actor.orgId,
          id: "delivery_ledger",
          key: "delivery_ledger",
          name: "Delivery ledger",
          kind: "fixed",
          confidentialityLevel: null,
          allowGroup: false,
          allowStore: true
        }
      });
      const ledgerSelector = { ...selector, enterpriseKey };
      let current = { version: 0, controlVersion: 0, integration: { version: 0 }, workflowId: "" };
      const change = async (value: unknown) => {
        const expected = {
          expectedVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion
        };
        const preview = await call("prepare_enterprise_workflow_change", {
          ...ledgerSelector,
          ...expected,
          change: value
        });
        expect(preview.statusCode, preview.body).toBe(200);
        const saved = await call("save_enterprise_workflow", {
          ...ledgerSelector,
          ...expected,
          previewId: preview.json().previewId,
          confirmationDigest: preview.json().confirmationDigest
        });
        expect(saved.statusCode, saved.body).toBe(200);
        current = saved.json();
      };
      await change({
        kind: "configuration",
        configuration: { ...configuration, datasets: ["delivery_ledger"] }
      });
      await change({
        kind: "integration",
        configuration: {
          schemaVersion: 1,
          timezone: "Asia/Shanghai",
          sourceAccounts: [
            {
              product: "meituan_erp",
              accountRef: "receipt-source",
              displayName: "Receipt source",
              sourceEnterpriseName: "Receipt enterprise"
            }
          ],
          storeMappings: [
            {
              storeName: "Store A",
              source: {
                product: "meituan_erp",
                channel: "erp",
                accountRef: "receipt-source",
                sourceStoreId: "receipt-poi",
                sourceStoreName: "Store A"
              }
            }
          ],
          exclusions: []
        }
      });
      await change({
        kind: "authorization",
        grant: [{ kind: "upload", datasets: ["delivery_ledger"], storeNames: ["Store A"] }],
        revokeAuthorizationIds: []
      });
      await change({ kind: "control", state: "active", reason: "Synthetic receipt test" });
      const workflowId = current.workflowId;
      const install = (operation: unknown) =>
        call("manage_workflow_installation", { workflowId, operation });
      expect(
        (
          await install({
            kind: "register",
            installation: {
              installationId: "receipt-mac",
              deviceAlias: "Receipt Mac",
              host: "codex",
              platform: "macos",
              launcherVersion: "0.16.0",
              workflowPackageVersion: "1.0.3",
              hostSnapshot: {
                host: "codex",
                platform: "macos",
                taskId: "receipt-task",
                projectRef: "project",
                cron: "0 3 * * *",
                timezone: "Asia/Shanghai",
                model: "configured-model",
                reasoningEffort: "high",
                state: "paused",
                verifiedAt: testClock.toISOString()
              }
            }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await install({
            kind: "record_checks",
            installationId: "receipt-mac",
            checks: [
              "configuration",
              "permissions",
              "workspace",
              "dependencies",
              "host_schedule",
              "host_timezone",
              "host_model",
              "download",
              "meituan_erp"
            ].map((capability) => ({
              capability,
              status: "ready",
              nextStep: "",
              checkedAt: testClock.toISOString()
            })),
            firstRunVerification: "not_run"
          })
        ).statusCode
      ).toBe(200);
      const preview = (
        await install({
          kind: "prepare_takeover",
          installationId: "receipt-mac",
          expectedAssignmentEpoch: 0,
          oldHostState: "paused"
        })
      ).json();
      expect(
        (
          await install({
            kind: "takeover",
            installationId: "receipt-mac",
            expectedAssignmentEpoch: 0,
            previewId: preview.previewId,
            confirmationDigest: preview.confirmationDigest
          })
        ).statusCode
      ).toBe(200);
      const window = (await call("get_workflow_status", { workflowId })).json().expectedWindow;
      const started = await call("manage_workflow_run", {
        workflowId,
        operation: {
          kind: "start",
          installationId: "receipt-mac",
          assignmentEpoch: 1,
          expectedConfigurationVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion,
          workflowPackageVersion: "1.0.3",
          window,
          mode: "scheduled"
        }
      });
      expect(started.statusCode, started.body).toBe(200);
      const binding = {
        installationId: "receipt-mac",
        assignmentEpoch: 1,
        controlVersion: current.controlVersion,
        runId: started.json().runId
      };
      const csv = [
        "送货单",
        "单据号,SYNTHETIC-RECEIPT,订货机构,Store A",
        "送货机构,Synthetic Supplier,收货日期," + window.startDate,
        "序号,物品名称,规格型号,收货数量,收货金额",
        "1,Synthetic item,unit,1,80",
        "合计,,,1,80",
        "验收人,Synthetic"
      ].join("\n");
      const sourceHash = createHash("sha256").update(csv).digest("hex");
      const action = (operation: unknown) =>
        call("record_workflow_action", { workflowId, operation });
      const intent = {
        actionId: "receipt-upload",
        identity: {
          kind: "upload",
          dataset: "delivery_ledger",
          storeNames: ["Store A"],
          window,
          sourceHash,
          metadataHash: "b".repeat(64)
        }
      };
      expect(
        (await action({ kind: "intent", ...binding, actions: [intent] })).json().actions[0]
          .permitted
      ).toBe(true);
      const boundary = "synthetic-receipt-upload";
      const payload = [
        ...Object.entries({
          dataset: "delivery_ledger",
          enterpriseName: enterpriseKey,
          idempotencyKey: "synthetic-receipt-upload"
        }).map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        ),
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`
      ].join("");
      const uploaded = await app.inject({
        method: "POST",
        url: "/v1/structured/imports",
        headers: {
          authorization: "Bearer synthetic",
          "content-type": `multipart/form-data; boundary=${boundary}`
        },
        payload
      });
      expect(uploaded.statusCode, uploaded.body).toBe(202);
      const jobId = uploaded.json().importBatch.importBatchId;
      const receipt = {
        actionId: "receipt-upload",
        state: "confirmed",
        evidence: "service_status",
        jobId,
        verifiedAt: testClock.toISOString()
      };
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [receipt] })).statusCode
      ).toBe(409);
      const worker = createPrismaProcessingWorkerRepository(database.databaseUrl);
      try {
        expect(
          await runWorkerOnce({ repository: worker, storage, workerId: "receipt-worker" })
        ).toMatchObject({ processed: true, status: "active" });
      } finally {
        await worker.disconnect?.();
      }
      const status = await app.inject({
        method: "GET",
        url: `/v1/structured/imports/${jobId}`,
        headers: { authorization: "Bearer synthetic" }
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        document: { status: "active" },
        processing: { status: "succeeded" },
        importBatch: { status: "applied" }
      });
      expect(uploaded.json().importBatch).toMatchObject({
        startDate: window.startDate.replaceAll("-", ""),
        endDate: window.endDate.replaceAll("-", "")
      });
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [receipt] })).statusCode
      ).toBe(200);
      expect(
        (await action({ kind: "get", actionIds: ["receipt-upload"] })).json().actions[0]
      ).toMatchObject({ state: "confirmed", receipt });
      const mismatched = {
        ...intent,
        actionId: "receipt-wrong-source",
        identity: { ...intent.identity, sourceHash: "0".repeat(64) }
      };
      expect(
        (await action({ kind: "intent", ...binding, actions: [mismatched] })).json().actions[0]
          .permitted
      ).toBe(true);
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [{ ...receipt, actionId: mismatched.actionId }]
          })
        ).statusCode
      ).toBe(409);
      expect((await action({ kind: "get", actionIds: ["receipt-upload"] })).body).not.toContain(
        "Synthetic item"
      );
    });

    it("reports only elapsed gaps under a confirmed enabled local schedule", async () => {
      const originalClock = testClock;
      const state = (
        await call("get_enterprise_workflow", { ...selector, enterpriseKey: "receipt-enterprise" })
      ).json();
      const workflowId = state.workflowId;
      const status = async () => (await call("get_workflow_status", { workflowId })).json();
      const originalHost = (await status()).installations[0].hostSnapshot;
      const host = async (cron: string, enabled: boolean) => {
        const recorded = await call("manage_workflow_installation", {
          workflowId,
          operation: {
            kind: "record_host",
            installationId: "receipt-mac",
            hostSnapshot: { ...originalHost, cron, state: enabled ? "enabled" : "paused" }
          }
        });
        expect(recorded.statusCode, recorded.body).toBe(200);
      };
      try {
        await host("0 3 * * *", true);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
          originalClock
        );
        const afterDays = (days: number) =>
          new Date(
            new Date(Date.parse(today + "T00:00:00Z") + days * 86400000)
              .toISOString()
              .slice(0, 10) + "T02:00:00+08:00"
          );
        testClock = afterDays(1);
        // Today's3am trigger has not occurred; do not guess a missed run from today's date.
        expect((await status()).possibleMissedWindow).toBe(false);
        testClock = afterDays(2);
        expect((await status()).possibleMissedWindow).toBe(true);
        await host("0 3 * * *", false);
        expect((await status()).possibleMissedWindow).toBe(false);
        await host("0 3 1 * *", true); // Unsupported monthly timing is unknown, not missed.
        expect((await status()).possibleMissedWindow).toBe(false);
        for (const cron of [
          "RRULE:FREQ=WEEKLY;BYHOUR=3;BYMINUTE=45;BYDAY=SU,MO,TU,WE,TH,FR,SA",
          "RRULE:FREQ=DAILY;BYHOUR=0,8,11,17,21;BYMINUTE=0,30;BYSECOND=0;BYSETPOS=1,4,5,7,9"
        ]) {
          await host(cron, true);
          expect((await status()).possibleMissedWindow).toBe(true);
        }
        const expected = {
          expectedVersion: state.version,
          expectedIntegrationVersion: state.integration.version,
          expectedControlVersion: state.controlVersion
        };
        const preview = (
          await call("prepare_enterprise_workflow_change", {
            ...selector,
            enterpriseKey: "receipt-enterprise",
            ...expected,
            change: { kind: "control", state: "paused", reason: "Synthetic gap pause" }
          })
        ).json();
        const paused = await call("save_enterprise_workflow", {
          ...selector,
          enterpriseKey: "receipt-enterprise",
          ...expected,
          previewId: preview.previewId,
          confirmationDigest: preview.confirmationDigest
        });
        expect(paused.statusCode, paused.body).toBe(200);
        expect((await status()).possibleMissedWindow).toBe(false);
      } finally {
        testClock = originalClock;
      }
    });

    it("imports every sealed migration page and retains all 101 durable completed actions", async () => {
      await prisma.businessEnterpriseIdentity.create({
        data: {
          orgId: actor.orgId,
          enterpriseKey: "migration",
          enterpriseName: "Migration fixture"
        }
      });
      await prisma.businessStore.create({
        data: { orgId: actor.orgId, enterpriseKey: "migration", name: "Store A" }
      });
      const migrationSelector = { ...selector, enterpriseKey: "migration" };
      const expected = {
        expectedVersion: 0,
        expectedIntegrationVersion: 0,
        expectedControlVersion: 0
      };
      const preview = (
        await call("prepare_enterprise_workflow_change", {
          ...migrationSelector,
          ...expected,
          change: { kind: "configuration", configuration }
        })
      ).json();
      const saved = (
        await call("save_enterprise_workflow", {
          ...migrationSelector,
          ...expected,
          previewId: preview.previewId,
          confirmationDigest: preview.confirmationDigest
        })
      ).json();
      const workflowId = saved.workflowId;
      const install = (operation: unknown) =>
        call("manage_workflow_installation", { workflowId, operation });
      const initial = (await call("get_enterprise_workflow", selector)).json();
      const completion = (i: number) => ({
        legacyKeyHash: i.toString(16).padStart(64, "0"),
        intent: {
          actionId: `legacy-${i}`,
          identity: {
            kind: "upload",
            dataset: "business",
            storeNames: ["Store A"],
            window: { startDate: "2026-01-01", endDate: "2026-01-01" },
            sourceHash: i.toString(16).padStart(64, "0"),
            metadataHash: "c".repeat(64)
          }
        },
        receipt: {
          actionId: `legacy-${i}`,
          state: "confirmed",
          evidence: "manual_resolution",
          receiptId: `legacy-receipt-${i}`,
          reason: "Matched retained historic receipt",
          verifiedAt: "2026-01-02T00:00:00.000Z"
        }
      });
      const manifest = {
        sourceSnapshotHash: "f".repeat(64),
        targetVersion: 0,
        integration: initial.integration.configuration,
        workflows: [
          {
            workflowId,
            configuration,
            authorizations: [{ kind: "upload", datasets: ["business"], storeNames: ["Store A"] }],
            hostSnapshot: {
              host: "codex",
              platform: "macos",
              taskId: "old-task",
              projectRef: "old-project",
              cron: "45 3 * * *",
              timezone: "Asia/Shanghai",
              model: "available-model",
              reasoningEffort: "high",
              state: "paused",
              verifiedAt: new Date().toISOString()
            },
            completedActions: Array.from({ length: 100 }, (_, i) => completion(i + 1)),
            unresolved: []
          }
        ]
      };
      const reviewSource = {
        product: "meituan_reviews",
        channel: "meituan",
        accountRef: "migration-reviews",
        sourceStoreId: "migration-poi",
        sourceStoreName: "Store A"
      };
      const portableManifest = {
        ...manifest,
        integration: {
          ...manifest.integration,
          sourceAccounts: [
            ...manifest.integration.sourceAccounts,
            {
              product: "meituan_reviews",
              accountRef: "migration-reviews",
              displayName: "Reviews",
              sourceEnterpriseName: "Synthetic"
            }
          ],
          storeMappings: [
            ...manifest.integration.storeMappings,
            { storeName: "Store A", source: reviewSource }
          ]
        },
        workflows: [
          ...manifest.workflows,
          {
            workflowId: "migration-weekly",
            configuration: {
              schemaVersion: 1,
              type: "weekly-business-report",
              storeNames: ["Store A"],
              notificationPolicy: "action_required",
              groups: [],
              delivery: { enabled: false, recipients: [] },
              cleanupPolicy: "retain_final_report"
            },
            authorizations: [],
            hostSnapshot: { ...manifest.workflows[0]!.hostSnapshot, taskId: "old-weekly-task" },
            completedActions: [],
            unresolved: []
          },
          {
            workflowId: "migration-reviews",
            configuration: {
              schemaVersion: 1,
              type: "meituan-review-operations",
              executionPolicy: { id: "verified-review-operations", version: 1 },
              ignoredReviewIdentities: [],
              storeNames: ["Store A"],
              notificationPolicy: "action_required",
              channels: ["meituan"],
              publication: { enabled: false, storeNames: [] },
              brandFacts: "Synthetic",
              tone: "Helpful",
              draftNotification: { enabled: false, recipients: [] },
              cleanupPolicy: "complete_run_only"
            },
            authorizations: [],
            hostSnapshot: { ...manifest.workflows[0]!.hostSnapshot, taskId: "old-review-task" },
            completedActions: [],
            unresolved: []
          }
        ]
      };
      const prepared = await install({ kind: "migration_preview", manifest: portableManifest });
      expect(prepared.statusCode, prepared.body).toBe(200);
      let migration = prepared.json();
      expect(
        (await install({ kind: "migration_preview", manifest: portableManifest })).json()
          .migrationId
      ).toBe(migration.migrationId);
      const recoveryItems = [
        {
          itemId: "pending-export",
          kind: "business",
          disposition: "open",
          stage: "collecting",
          scope: {
            kind: "dataset",
            dataset: "business",
            storeNames: ["Store A"],
            window: { startDate: "2026-01-01", endDate: "2026-01-01" }
          }
        },
        {
          itemId: "declined-backfill",
          kind: "business",
          disposition: "waived",
          stage: "finished",
          scope: {
            kind: "dataset",
            dataset: "business",
            storeNames: ["Store A"],
            window: { startDate: "2025-01-01", endDate: "2025-01-31" }
          },
          resolutionReason: "Administrator declined the historical backfill"
        },
        {
          itemId: "missing-evidence",
          kind: "evidence",
          disposition: "open",
          stage: "verifying",
          scope: { kind: "unknown_scope", reason: "missing_local_evidence" },
          evidenceHash: "a".repeat(64)
        },
        {
          itemId: "located-report",
          kind: "evidence",
          disposition: "resolved",
          stage: "finished",
          scope: {
            kind: "report",
            storeNames: ["Store A"],
            window: { startDate: "2026-01-01", endDate: "2026-01-07" }
          },
          evidenceRef: "central-report",
          resolutionReason: "Located the central report"
        }
      ];
      const chunk = [
        { workflowId, completedActions: [completion(101)], unresolved: [], recoveryItems }
      ];
      const chunkHash = createHash("sha256").update(workflowCanonicalJson(chunk)).digest("hex");
      const appended = await install({
        kind: "migration_append",
        migrationId: migration.migrationId,
        expectedVersion: migration.version,
        sequence: 1,
        chunk,
        chunkHash
      });
      expect(appended.statusCode, appended.body).toBe(200);
      migration = appended.json();
      expect(migration.recordCount).toBe(105);
      const page = (
        await install({ kind: "migration_get", migrationId: migration.migrationId })
      ).json();
      expect(page.nextCursor).toBe(1);
      expect(page.chunks[0].chunk[0].completedActions).toHaveLength(100);
      expect(page.chunks[0].chunk[0]).not.toHaveProperty("recoveryItems");
      expect(
        (
          await install({
            kind: "migration_seal",
            migrationId: migration.migrationId,
            expectedVersion: migration.version,
            chunkCount: 1,
            recordCount: 100,
            chunksDigest: migration.chunksDigest
          })
        ).statusCode
      ).toBe(409);
      migration = (
        await install({
          kind: "migration_seal",
          migrationId: migration.migrationId,
          expectedVersion: migration.version,
          chunkCount: 2,
          recordCount: 105,
          chunksDigest: migration.chunksDigest
        })
      ).json();
      for (const stage of ["validated", "validated", "imported", "imported"]) {
        const result = await install({
          kind: "migration_advance",
          migrationId: migration.migrationId,
          sourceSnapshotHash: manifest.sourceSnapshotHash,
          expectedVersion: migration.version,
          stage,
          confirmationDigest: migration.confirmationDigest
        });
        expect(result.statusCode, result.body).toBe(200);
        migration = result.json();
      }
      expect(migration).toMatchObject({
        stage: "imported",
        recordCount: 105,
        importedChunks: 2,
        complete: true
      });
      const state = (await call("get_enterprise_workflow", migrationSelector)).json();
      expect(state).toMatchObject({
        version: 2,
        controlState: "paused",
        integration: { orderScopeRequired: false }
      });
      const history = (
        await call("record_workflow_action", {
          workflowId,
          operation: { kind: "get", actionIds: ["legacy-1", "legacy-100", "legacy-101"] }
        })
      ).json();
      expect(history.actions).toHaveLength(3);
      expect(history.actions.every((a: { state: string }) => a.state === "confirmed")).toBe(true);
      const discovered = (await call("get_workflow_status", { workflowId, limit: 1 })).json();
      expect(discovered.migrations).toEqual([
        expect.objectContaining({
          migrationId: migration.migrationId,
          stage: "imported",
          recordCount: 105,
          workflowIds: expect.arrayContaining([workflowId, "migration-weekly", "migration-reviews"])
        })
      ]);
      const recovered = await install({
        kind: "migration_get",
        migrationId: discovered.migrations[0].migrationId,
        cursor: 1
      });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json().chunks[0]).toMatchObject({
        recordCount: 5,
        chunk: [{ workflowId, recoveryItems }]
      });
      expect(recovered.json().nextCursor).toBeNull();
      expect(
        (
          await call("record_workflow_action", {
            workflowId,
            operation: { kind: "get", actionIds: recoveryItems.map((item) => item.itemId) }
          })
        ).json().actions
      ).toEqual([]);
      for (const member of ["migration-weekly", "migration-reviews"]) {
        const memberStatus = (
          await call("get_workflow_status", { workflowId: member, limit: 1 })
        ).json();
        expect(memberStatus.migrations[0].migrationId).toBe(migration.migrationId);
        const restored = await call("manage_workflow_installation", {
          workflowId: member,
          operation: { kind: "migration_get", migrationId: memberStatus.migrations[0].migrationId }
        });
        expect(restored.statusCode, restored.body).toBe(200);
        expect(restored.json().manifest.workflows).toHaveLength(3);
      }
      const advanceHost = (stage = "host_switched") =>
        install({
          kind: "migration_advance",
          migrationId: migration.migrationId,
          sourceSnapshotHash: manifest.sourceSnapshotHash,
          expectedVersion: migration.version,
          stage,
          confirmationDigest: migration.confirmationDigest
        });
      const unassigned = await advanceHost();
      expect(unassigned.json().error.code).toBe("WORKFLOW_INSTALLATION_MISMATCH");
      for (const member of portableManifest.workflows) {
        const memberInstall = (operation: unknown) =>
          call("manage_workflow_installation", { workflowId: member.workflowId, operation });
        const hostSnapshot = {
          ...member.hostSnapshot,
          // A different computer may receive a new ID; same-computer upgrades retain theirs.
          taskId:
            member.workflowId === "migration-weekly"
              ? "new-weekly-task"
              : member.hostSnapshot.taskId,
          verifiedAt: testClock.toISOString()
        };
        expect(
          (
            await memberInstall({
              kind: "register",
              installation: {
                installationId: "migration-mac",
                deviceAlias: "Synthetic Mac",
                host: "codex",
                platform: "macos",
                launcherVersion: "0.16.0",
                workflowPackageVersion: "1.0.3",
                hostSnapshot
              }
            })
          ).statusCode
        ).toBe(200);
        expect(
          (
            await memberInstall({
              kind: "record_checks",
              installationId: "migration-mac",
              firstRunVerification: "not_run",
              checks: [
                "configuration",
                "permissions",
                "workspace",
                "dependencies",
                "host_schedule",
                "host_timezone",
                "host_model",
                "download",
                "meituan_erp",
                "meituan_reviews"
              ].map((capability) => ({
                capability,
                status: "ready",
                nextStep: "",
                checkedAt: testClock.toISOString()
              }))
            })
          ).statusCode
        ).toBe(200);
        const takeover = await memberInstall({
          kind: "prepare_takeover",
          installationId: "migration-mac",
          expectedAssignmentEpoch: 0,
          oldHostState: "paused"
        });
        expect(takeover.statusCode, takeover.body).toBe(200);
        expect(
          (
            await memberInstall({
              kind: "takeover",
              installationId: "migration-mac",
              expectedAssignmentEpoch: 0,
              previewId: takeover.json().previewId,
              confirmationDigest: takeover.json().confirmationDigest
            })
          ).statusCode
        ).toBe(200);
      }
      const freshHost = {
        ...manifest.workflows[0]!.hostSnapshot,
        verifiedAt: testClock.toISOString()
      };
      await install({
        kind: "record_host",
        installationId: "migration-mac",
        hostSnapshot: {
          ...freshHost,
          verifiedAt: new Date(Date.parse(migration.createdAt) - 120000).toISOString()
        }
      });
      const staleHost = await advanceHost();
      expect(staleHost.json().error.code).toBe("WORKFLOW_SOURCE_UNAVAILABLE");
      await install({
        kind: "record_host",
        installationId: "migration-mac",
        hostSnapshot: freshHost
      });
      const switched = await advanceHost();
      expect(switched.statusCode, switched.body).toBe(200);
      migration = switched.json();
      expect(migration.stage).toBe("host_switched");
      const unverified = await advanceHost("verified");
      expect(unverified.json().error.code).toBe("WORKFLOW_SOURCE_UNAVAILABLE");
      const another = await install({
        kind: "migration_preview",
        manifest: {
          ...portableManifest,
          sourceSnapshotHash: "e".repeat(64),
          targetVersion: state.integration.version
        }
      });
      expect(another.statusCode, another.body).toBe(200);
      const migrationFirstPage = (
        await call("get_workflow_status", { workflowId, limit: 1 })
      ).json();
      expect(migrationFirstPage.migrations).toHaveLength(1);
      expect(migrationFirstPage.nextMigrationCursor).toEqual(expect.any(String));
      const migrationLastPage = (
        await call("get_workflow_status", {
          workflowId,
          limit: 1,
          migrationCursor: migrationFirstPage.nextMigrationCursor
        })
      ).json();
      expect(migrationLastPage.migrations).toHaveLength(1);
      expect(migrationLastPage.nextMigrationCursor).toBeNull();
      expect(
        [
          migrationFirstPage.migrations[0].migrationId,
          migrationLastPage.migrations[0].migrationId
        ].sort()
      ).toEqual([migration.migrationId, another.json().migrationId].sort());
      const unrelatedWorkflow = (await call("get_enterprise_workflow", selector)).json().workflowId;
      expect(
        (await call("get_workflow_status", { workflowId: unrelatedWorkflow })).json().migrations
      ).toEqual([]);
    });
    it("exposes controlled MCP reads and rejects stale roles, disabled accounts and foreign tenants", async () => {
      const mcp = async (name: string, args: unknown) => {
        const result = await callMcp(name, args);
        expect(result.isError, result.content[0].text).not.toBe(true);
        return JSON.parse(result.content[0].text);
      };
      const detail = { query: { mode: "detail", ...selector } };
      const old = await callMcp("query_enterprise_workflows", detail, "0.16.0");
      expect(JSON.parse(old.content[0].text)).toMatchObject({
        error: { code: "LAUNCHER_UPGRADE_REQUIRED" }
      });
      const unfiltered = await mcp("query_enterprise_workflows", {
        query: { mode: "list", limit: 1 }
      });
      expect(unfiltered.workflows).toHaveLength(1);
      expect(unfiltered.nextCursor).toEqual(expect.any(String));
      const continued = await mcp("query_enterprise_workflows", {
        query: { mode: "list", limit: 1, cursor: unfiltered.nextCursor }
      });
      expect(continued.workflows).toHaveLength(1);
      expect(continued.workflows[0].workflowId).not.toBe(unfiltered.workflows[0].workflowId);
      const filtered = { enterpriseKey: selector.enterpriseKey, limit: 1 };
      expect(
        await mcp("query_enterprise_workflows", { query: { mode: "list", ...filtered } })
      ).toEqual((await call("list_enterprise_workflows", filtered)).json());
      const state = await mcp("query_enterprise_workflows", detail);
      expect(state).toMatchObject({
        enterpriseKey: "enterprise",
        workflowType: selector.workflowType
      });
      const expected = {
        expectedVersion: state.version,
        expectedIntegrationVersion: state.integration.version,
        expectedControlVersion: state.controlVersion
      };
      const preview = await mcp("prepare_enterprise_workflow_change", {
        ...selector,
        ...expected,
        change: { kind: "configuration", configuration: state.configuration }
      });
      const saved = await mcp("save_enterprise_workflow", {
        ...selector,
        ...expected,
        previewId: preview.previewId,
        confirmationDigest: preview.confirmationDigest
      });
      expect(saved.version).toBe(state.version + 1);
      const status = await mcp("get_workflow_status", { workflowId: state.workflowId });
      const run = status.runs[0];
      const recoveredStatus = await mcp("get_workflow_status", {
        workflowId: state.workflowId,
        runId: run.runId
      });
      expect(recoveredStatus.runActionRefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "upload-action",
            state: "confirmed",
            runId: run.runId
          })
        ])
      );
      expect(
        (
          await mcp("manage_workflow_run", {
            workflowId: state.workflowId,
            operation: {
              kind: "renew",
              installationId: run.installationId,
              runId: run.runId,
              assignmentEpoch: run.assignmentEpoch,
              controlVersion: state.controlVersion
            }
          })
        ).runId
      ).toBe(run.runId);
      expect(
        (
          await mcp("record_workflow_action", {
            workflowId: state.workflowId,
            operation: { kind: "get", actionIds: ["upload-action"] }
          })
        ).actions[0].state
      ).toBe("confirmed");
      const expectAdminDenied = async () => {
        const denied = await callMcp("query_enterprise_workflows", detail);
        expect(JSON.parse(denied.content[0].text)).toMatchObject({
          error: { code: "WORKFLOW_ADMIN_REQUIRED" }
        });
      };
      await prisma.employee.update({ where: { id: actor.id }, data: { role: "employee" } });
      await expectAdminDenied();
      await prisma.employee.update({
        where: { id: actor.id },
        data: { role: "admin", disabled: true }
      });
      await expectAdminDenied();
      expect((await call("get_enterprise_workflow", selector)).statusCode).toBe(403);
      await prisma.employee.update({ where: { id: actor.id }, data: { disabled: false } });
      const originalOrg = actor.orgId;
      actor.orgId = "foreign-org";
      await expectAdminDenied();
      expect((await call("get_enterprise_workflow", selector)).statusCode).toBe(403);
      actor.orgId = originalOrg;
    });
    it("refuses expired execution, explicitly transfers unfinished snapshots and blocks the old installation", async () => {
      testClock = new Date(testClock.getTime() + 180000);
      const current = (await call("get_enterprise_workflow", selector)).json();
      const status = (await call("get_workflow_status", { workflowId: current.workflowId })).json();
      const previousRun = status.runs[0];
      const oldBinding = {
        runId: previousRun.runId,
        installationId: "mac-a",
        assignmentEpoch: 1,
        controlVersion: current.controlVersion
      };
      const run = (operation: unknown) =>
        call("manage_workflow_run", { workflowId: current.workflowId, operation });
      expect((await run({ kind: "renew", ...oldBinding })).statusCode).toBe(409);
      expect(
        (
          await run({
            kind: "start",
            installationId: "mac-a",
            assignmentEpoch: 1,
            expectedConfigurationVersion: current.version,
            expectedIntegrationVersion: current.integration.version,
            expectedControlVersion: current.controlVersion,
            workflowPackageVersion: "1.0.3",
            window: previousRun.snapshot.window,
            mode: "backfill",
            backfillConfirmationDigest: "0".repeat(64)
          })
        ).statusCode
      ).toBe(409);
      const install = (operation: unknown) =>
        call("manage_workflow_installation", { workflowId: current.workflowId, operation });
      expect(
        (
          await install({
            kind: "register",
            installation: {
              installationId: "mac-b",
              deviceAlias: "Replacement Mac",
              host: "codex",
              platform: "macos",
              launcherVersion: "0.16.0",
              workflowPackageVersion: "1.0.3",
              hostSnapshot: {
                host: "codex",
                platform: "macos",
                taskId: "new-task",
                projectRef: "new-project",
                cron: "45 3 * * *",
                timezone: "Asia/Shanghai",
                model: "available-model",
                reasoningEffort: "high",
                state: "paused",
                verifiedAt: testClock.toISOString()
              }
            }
          })
        ).statusCode
      ).toBe(200);
      const checks = [
        "configuration",
        "permissions",
        "workspace",
        "dependencies",
        "host_schedule",
        "host_timezone",
        "host_model",
        "download",
        "meituan_erp"
      ].map((capability) => ({
        capability,
        status: "ready",
        nextStep: "",
        checkedAt: testClock.toISOString()
      }));
      await install({
        kind: "record_checks",
        installationId: "mac-b",
        checks,
        firstRunVerification: "not_run"
      });
      const takeover = (
        await install({
          kind: "prepare_takeover",
          installationId: "mac-b",
          expectedAssignmentEpoch: 1,
          oldHostState: "unavailable"
        })
      ).json();
      expect(
        (
          await install({
            kind: "takeover",
            installationId: "mac-b",
            expectedAssignmentEpoch: 1,
            previewId: takeover.previewId,
            confirmationDigest: takeover.confirmationDigest
          })
        ).statusCode
      ).toBe(200);
      expect((await run({ kind: "resume", ...oldBinding })).statusCode).toBe(409);
      const resumed = await run({
        kind: "resume",
        ...oldBinding,
        installationId: "mac-b",
        assignmentEpoch: 2
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json().snapshot.configuration.datasets).toEqual(["business"]);
      expect(
        (
          await run({
            kind: "finish",
            ...oldBinding,
            installationId: "mac-b",
            assignmentEpoch: 2,
            summary: {
              phase: "finished",
              status: "succeeded",
              observations: [],
              unresolved: [],
              cleanup: "retained"
            }
          })
        ).statusCode
      ).toBe(200);
      const window = { startDate: "2026-10-01", endDate: "2026-10-02" };
      const backfill = await run({
        kind: "prepare_backfill",
        installationId: "mac-b",
        assignmentEpoch: 2,
        window,
        reason: "Explicit synthetic repair"
      });
      expect(backfill.statusCode).toBe(200);
      const start = {
        kind: "start",
        installationId: "mac-b",
        assignmentEpoch: 2,
        expectedConfigurationVersion: current.version,
        expectedIntegrationVersion: current.integration.version,
        expectedControlVersion: current.controlVersion,
        workflowPackageVersion: "1.0.3",
        window,
        mode: "backfill",
        backfillConfirmationDigest: backfill.json().confirmationDigest
      };
      expect(
        (await run({ ...start, window: { startDate: "2026-09-30", endDate: "2026-10-02" } }))
          .statusCode
      ).toBe(403);
      expect((await run(start)).statusCode).toBe(200);
    });

    it("requires bound local provider readback and deduplicates every review recipient across regrouping", async () => {
      const reviewSelector = {
        enterpriseKey: "enterprise",
        workflowType: "meituan-review-operations"
      };
      const source = {
        product: "meituan_reviews",
        channel: "meituan",
        accountRef: "reviews-account",
        sourceStoreId: "review-poi",
        sourceStoreName: "Source Review Store"
      };
      const recipients = [
        "first@example.invalid",
        "second@example.invalid",
        "third@example.invalid"
      ];
      const reviewConfig = {
        schemaVersion: 1,
        type: reviewSelector.workflowType,
        executionPolicy: { id: "verified-review-operations", version: 1 },
        ignoredReviewIdentities: [
          {
            source,
            feedbackId: "excluded-feedback",
            reason: "Previously confirmed exclusion",
            purpose: "exclude_source_record"
          }
        ],
        storeNames: ["Store A"],
        notificationPolicy: "action_required",
        channels: ["meituan"],
        publication: { enabled: true, storeNames: ["Store A"] },
        brandFacts: "Synthetic brand",
        tone: "Helpful",
        draftNotification: { enabled: true, recipients, allowedSender: "sender@example.invalid" },
        cleanupPolicy: "complete_run_only"
      };
      const initial = (await call("get_enterprise_workflow", selector)).json();
      let current = {
        version: 0,
        controlVersion: 0,
        integration: initial.integration,
        workflowId: ""
      };
      const change = async (value: unknown) => {
        const expected = {
          expectedVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion
        };
        const preview = (
          await call("prepare_enterprise_workflow_change", {
            ...reviewSelector,
            ...expected,
            change: value
          })
        ).json();
        const saved = await call("save_enterprise_workflow", {
          ...reviewSelector,
          ...expected,
          previewId: preview.previewId,
          confirmationDigest: preview.confirmationDigest
        });
        expect(saved.statusCode, saved.body).toBe(200);
        current = saved.json();
      };
      await change({ kind: "configuration", configuration: reviewConfig });
      await change({
        kind: "integration",
        configuration: {
          ...initial.integration.configuration,
          sourceAccounts: [
            ...initial.integration.configuration.sourceAccounts,
            {
              product: "meituan_reviews",
              accountRef: "reviews-account",
              displayName: "Reviews",
              sourceEnterpriseName: "Synthetic"
            }
          ],
          storeMappings: [
            ...initial.integration.configuration.storeMappings,
            { source, storeName: "Store A" }
          ]
        }
      });
      // Incomplete drafts remain editable, but cannot become active with a selected unmapped channel.
      await change({
        kind: "configuration",
        configuration: { ...reviewConfig, channels: ["meituan", "dianping"] }
      });
      const incompleteExpected = {
        expectedVersion: current.version,
        expectedIntegrationVersion: current.integration.version,
        expectedControlVersion: current.controlVersion
      };
      const incompletePreview = (
        await call("prepare_enterprise_workflow_change", {
          ...reviewSelector,
          ...incompleteExpected,
          change: { kind: "control", state: "active", reason: "Must refuse incomplete channels" }
        })
      ).json();
      const incompleteActivation = await call("save_enterprise_workflow", {
        ...reviewSelector,
        ...incompleteExpected,
        previewId: incompletePreview.previewId,
        confirmationDigest: incompletePreview.confirmationDigest
      });
      expect(incompleteActivation.statusCode).toBe(409);
      expect(incompleteActivation.json().error.code).toBe("WORKFLOW_SOURCE_MAPPING_CONFLICT");
      await change({ kind: "configuration", configuration: reviewConfig });
      await change({
        kind: "authorization",
        grant: [
          { kind: "review_publish", channels: ["meituan"], storeNames: ["Store A"] },
          { kind: "review_sync", channels: ["meituan"], storeNames: ["Store A"] },
          {
            kind: "email",
            purpose: "review_drafts",
            storeNames: ["Store A"],
            recipients,
            allowedSender: "sender@example.invalid",
            deliveryVersion: 1
          }
        ],
        revokeAuthorizationIds: []
      });
      await change({ kind: "control", state: "active", reason: "Synthetic test" });
      const workflowId = current.workflowId;
      const install = (operation: unknown) =>
        call("manage_workflow_installation", { workflowId, operation });
      await install({
        kind: "register",
        installation: {
          installationId: "review-mac",
          deviceAlias: "Review Mac",
          host: "codex",
          platform: "macos",
          launcherVersion: "0.16.0",
          workflowPackageVersion: "1.0.3",
          hostSnapshot: {
            host: "codex",
            platform: "macos",
            taskId: "review-task",
            projectRef: "project",
            cron: "0 0,8,11,17,21 * * *",
            timezone: "Asia/Shanghai",
            model: "available-model",
            reasoningEffort: "high",
            state: "paused",
            verifiedAt: testClock.toISOString()
          }
        }
      });
      const checks = [
        "configuration",
        "permissions",
        "workspace",
        "dependencies",
        "host_schedule",
        "host_timezone",
        "host_model",
        "meituan_reviews",
        "email_identity",
        "sent_mail_lookup"
      ].map((capability) => ({
        capability,
        status: "ready",
        nextStep: "",
        checkedAt: testClock.toISOString()
      }));
      await install({
        kind: "record_checks",
        installationId: "review-mac",
        checks,
        firstRunVerification: "not_run"
      });
      await change({
        kind: "configuration",
        configuration: { ...reviewConfig, channels: ["meituan", "dianping"] }
      });
      const missingChannelReady = await install({
        kind: "prepare_takeover",
        installationId: "review-mac",
        expectedAssignmentEpoch: 0,
        oldHostState: "paused"
      });
      expect(missingChannelReady.statusCode).toBe(409);
      expect(missingChannelReady.json().error.code).toBe("WORKFLOW_SOURCE_MAPPING_CONFLICT");
      await change({ kind: "configuration", configuration: reviewConfig });
      const preview = (
        await install({
          kind: "prepare_takeover",
          installationId: "review-mac",
          expectedAssignmentEpoch: 0,
          oldHostState: "paused"
        })
      ).json();
      await install({
        kind: "takeover",
        installationId: "review-mac",
        expectedAssignmentEpoch: 0,
        previewId: preview.previewId,
        confirmationDigest: preview.confirmationDigest
      });
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
        testClock
      );
      const window = {
        startDate: new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10),
        endDate: today
      };
      const started = await call("manage_workflow_run", {
        workflowId,
        operation: {
          kind: "start",
          installationId: "review-mac",
          assignmentEpoch: 1,
          expectedConfigurationVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion,
          workflowPackageVersion: "1.0.3",
          window,
          mode: "scheduled"
        }
      });
      expect(started.statusCode, started.body).toBe(200);
      const binding = {
        installationId: "review-mac",
        assignmentEpoch: 1,
        controlVersion: current.controlVersion,
        runId: started.json().runId
      };
      const action = (operation: unknown) =>
        call("record_workflow_action", { workflowId, operation });
      const reviews = ["sync-feedback-1", "sync-feedback-2"].map((feedbackId) => ({
        enterpriseName: "enterprise",
        source: "美团评价",
        storeName: "Store A",
        reviewedAt: window.startDate + "T08:00:00+08:00",
        reviewerName: feedbackId,
        feedbackId,
        content: "Synthetic review",
        merchantReply: null,
        replyStatus: "unreplied_with_content"
      }));
      const observedFactsHash = createHash("sha256")
        .update(workflowCanonicalJson(reviews))
        .digest("hex");
      const syncIntent = {
        actionId: "review-sync",
        identity: {
          kind: "review_sync",
          storeNames: ["Store A"],
          window,
          source,
          observedFactsHash
        }
      };
      const sync = await action({ kind: "intent", ...binding, actions: [syncIntent] });
      expect(sync.statusCode, sync.body).toBe(200);
      await prisma.businessCategory.create({
        data: {
          orgId: actor.orgId,
          id: "store_reviews",
          key: "store_reviews",
          name: "Reviews",
          kind: "fixed",
          confidentialityLevel: 1,
          allowGroup: false,
          allowStore: true
        }
      });
      const businessPermissions = createBusinessAuthorizationRepository({ prisma });
      const setReviewRead = async (enabled: boolean) =>
        businessPermissions.configureAccount({
          orgId: actor.orgId,
          actorId: actor.id,
          employeeId: actor.id,
          expectedVersion: String(
            (
              await prisma.businessAuthorizationState.findUniqueOrThrow({
                where: { orgId: actor.orgId }
              })
            ).version
          ),
          clearance: 3,
          grants: enabled
            ? [
                {
                  id: "review-read-grant",
                  orgId: actor.orgId,
                  enterpriseKey: "enterprise",
                  categoryIds: ["store_reviews"],
                  ownership: "store",
                  stores: { kind: "fixed", values: ["Store A"] },
                  dimensions: {}
                }
              ]
            : []
        });
      const upsert = await app.inject({
        method: "POST",
        url: "/v1/store-reviews/upsert",
        headers: { authorization: "Bearer synthetic" },
        payload: { reviews }
      });
      expect(upsert.statusCode, upsert.body).toBe(200);
      expect(upsert.json()).toMatchObject({ received: 2, inserted: 2 });
      await setReviewRead(true);
      let readbackRpcId = 300;
      const queryReviews = async (cursor?: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/mcp",
          remoteAddress: "127.0.0.1",
          headers: {
            host: "127.0.0.1:3000",
            authorization: "Bearer synthetic",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-smedc-launcher-version": "0.16.0"
          },
          payload: {
            jsonrpc: "2.0",
            id: readbackRpcId++,
            method: "tools/call",
            params: {
              name: "query_store_reviews",
              arguments: {
                enterpriseName: "enterprise",
                storeNames: ["Store A"],
                sources: ["美团评价"],
                reviewedAtFrom: window.startDate + "T00:00:00+08:00",
                reviewedAtTo: window.endDate + "T23:59:59+08:00",
                limit: 1,
                ...(cursor ? { cursor } : {})
              }
            }
          }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().error, response.body).toBeUndefined();
        expect(response.json().result.isError, response.body).not.toBe(true);
        return JSON.parse(response.json().result.content[0].text);
      };
      const firstPage = await queryReviews();
      expect(firstPage.page.nextCursor).toEqual(expect.any(String));
      const lastPage = await queryReviews(firstPage.page.nextCursor);
      expect(lastPage.page.nextCursor).toBeNull();
      const resultHash = createHash("sha256")
        .update(workflowCanonicalJson([...firstPage.rows, ...lastPage.rows]))
        .digest("hex");
      const syncReceipt = {
        actionId: "review-sync",
        state: "confirmed",
        evidence: "smedc_readback",
        receiptId: "review-sync-readback",
        resultHash,
        verifiedAt: testClock.toISOString(),
        smedcReadback: {
          identityHash: sync.json().actions[0].identityHash,
          observedFactsHash,
          resultHash,
          observedAt: testClock.toISOString(),
          reviewCount: 2,
          matchedCount: 2,
          outcome: "matched",
          recordIds: [...firstPage.rows, ...lastPage.rows].map((r: { id: string }) => r.id)
        }
      };
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [
              {
                ...syncReceipt,
                smedcReadback: { ...syncReceipt.smedcReadback, observedFactsHash: "0".repeat(64) }
              }
            ]
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [
              {
                ...syncReceipt,
                smedcReadback: {
                  ...syncReceipt.smedcReadback,
                  recordIds: ["missing-row", syncReceipt.smedcReadback.recordIds[1]]
                }
              }
            ]
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [
              { ...syncReceipt, smedcReadback: { ...syncReceipt.smedcReadback, matchedCount: 1 } }
            ]
          })
        ).statusCode
      ).toBe(409);
      await setReviewRead(false);
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [syncReceipt] })).statusCode
      ).toBe(403);
      await setReviewRead(true);
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [syncReceipt] })).statusCode
      ).toBe(200);
      expect(
        (await action({ kind: "get", actionIds: ["review-sync"] })).json().actions[0]
      ).toMatchObject({ state: "confirmed", receipt: syncReceipt });
      const makeIntent = (actionId: string, selected: string[], renamed = false) => ({
        actionId,
        artifactHash: "a".repeat(64),
        correlationMarker: actionId,
        identity: {
          kind: "email",
          purpose: "review_drafts",
          storeNames: ["Store A"],
          window,
          recipients: selected,
          sender: "sender@example.invalid",
          deliveryVersion: 1,
          reviewIdentities: selected.map((recipient) => ({
            source: {
              ...source,
              sourceStoreName: renamed ? "Renamed source" : source.sourceStoreName
            },
            feedbackId: "feedback-1",
            recipient
          }))
        }
      });
      expect(
        (await call("get_enterprise_workflow", reviewSelector)).json().configuration
          .ignoredReviewIdentities
      ).toEqual(reviewConfig.ignoredReviewIdentities);
      const excludedPublish = await action({
        kind: "intent",
        ...binding,
        actions: [
          {
            actionId: "excluded-publish",
            artifactHash: "a".repeat(64),
            correlationMarker: "excluded-publish",
            identity: {
              kind: "review_publish",
              storeName: "Store A",
              source,
              feedbackId: "excluded-feedback",
              purpose: "customer_reply"
            }
          }
        ]
      });
      expect(excludedPublish.statusCode).toBe(403);
      const first = await action({
        kind: "intent",
        ...binding,
        actions: [makeIntent("email-one", recipients.slice(0, 2))]
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().actions[0].permitted).toBe(true);
      expect(
        (await action({ kind: "get", actionIds: ["email-one"] })).json().actions[0]
      ).toMatchObject({
        ...makeIntent("email-one", recipients.slice(0, 2)),
        identityHash: first.json().actions[0].identityHash,
        state: "intent"
      });
      const receipt = {
        actionId: "email-one",
        state: "confirmed",
        evidence: "provider_readback",
        receiptId: "gmail-receipt",
        verifiedAt: testClock.toISOString()
      };
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [receipt] })).statusCode
      ).toBe(409);
      const proof = {
        identityHash: first.json().actions[0].identityHash,
        artifactHash: "a".repeat(64),
        correlationMarker: "email-one",
        providerReceiptId: "gmail-receipt",
        observedAt: testClock.toISOString(),
        outcome: "sent"
      };
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [{ ...receipt, providerReadback: { ...proof, identityHash: "0".repeat(64) } }]
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [{ ...receipt, providerReadback: proof }]
          })
        ).statusCode
      ).toBe(200);
      const regroup = await action({
        kind: "intent",
        ...binding,
        actions: [makeIntent("email-regroup", recipients.slice(1), true)]
      });
      expect(regroup.json().actions[0]).toMatchObject({
        actionId: "email-one",
        state: "confirmed",
        permitted: false,
        claimedItems: 1,
        requestedItems: 2
      });
      expect(
        (await action({ kind: "get", actionIds: ["email-regroup"] })).json().actions
      ).toHaveLength(0);
      const remainder = await action({
        kind: "intent",
        ...binding,
        actions: [makeIntent("email-remainder", recipients.slice(2), true)]
      });
      expect(remainder.json().actions[0].permitted).toBe(true);
      const publishIntent = {
        actionId: "live-publication-check",
        artifactHash: "a".repeat(64),
        correlationMarker: "live-publication-check",
        identity: {
          kind: "review_publish",
          storeName: "Store A",
          source,
          feedbackId: "live-feedback",
          purpose: "customer_reply"
        }
      };
      const check = (intent: unknown, liveBinding = binding) =>
        call("manage_workflow_run", {
          workflowId,
          operation: { kind: "check_actions", ...liveBinding, actions: [intent] }
        });
      expect((await check(publishIntent)).statusCode).toBe(200);
      const ignoredLater = {
        ...publishIntent,
        actionId: "ignored-later",
        identity: { ...publishIntent.identity, feedbackId: "ignored-later" }
      };
      expect((await check(ignoredLater)).statusCode).toBe(200);
      await change({
        kind: "configuration",
        configuration: {
          ...reviewConfig,
          ignoredReviewIdentities: [
            ...reviewConfig.ignoredReviewIdentities,
            {
              source,
              feedbackId: "ignored-later",
              reason: "Explicit new exclusion",
              purpose: "exclude_source_record"
            }
          ]
        }
      });
      binding.controlVersion = current.controlVersion;
      expect(
        (
          await call("manage_workflow_run", {
            workflowId,
            operation: { kind: "resume", ...binding }
          })
        ).statusCode
      ).toBe(200);
      expect((await check(ignoredLater)).statusCode).toBe(403);
      await change({ kind: "configuration", configuration: reviewConfig });
      expect((await check(ignoredLater)).statusCode).toBe(403);
      const oldControl = current.controlVersion;
      await change({
        kind: "configuration",
        configuration: {
          ...reviewConfig,
          publication: { enabled: false, storeNames: [] },
          draftNotification: { ...reviewConfig.draftNotification, recipients: recipients.slice(1) }
        }
      });
      expect(current.controlVersion).toBe(oldControl + 1);
      expect((await check(publishIntent)).statusCode).toBe(409);
      binding.controlVersion = current.controlVersion;
      const resumed = await call("manage_workflow_run", {
        workflowId,
        operation: { kind: "resume", ...binding }
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json().snapshot).toEqual(started.json().snapshot);
      expect((await check(publishIntent)).statusCode).toBe(403);
      expect(
        (await check(makeIntent("removed-recipient", recipients.slice(0, 1)))).statusCode
      ).toBe(403);
      const blockedIntent = makeIntent("removed-recipient-intent", recipients.slice(0, 1));
      expect(
        (await action({ kind: "intent", ...binding, actions: [blockedIntent] })).statusCode
      ).toBe(403);
      expect(
        (await action({ kind: "get", actionIds: [blockedIntent.actionId] })).json().actions
      ).toEqual([]);
      expect(
        (await check(makeIntent("retained-recipient", recipients.slice(1, 2)))).statusCode
      ).toBe(200);
      await change({
        kind: "configuration",
        configuration: { ...reviewConfig, tone: "Updated next round" }
      });
      expect(current.controlVersion).toBe(binding.controlVersion);
      // Re-expansion never restores a removed capability/recipient to this unfinished run.
      expect((await check(publishIntent)).statusCode).toBe(403);
      expect(
        (await check(makeIntent("restored-recipient", recipients.slice(0, 1)))).statusCode
      ).toBe(403);
      const originalIntegration = (await call("get_enterprise_workflow", reviewSelector)).json()
        .integration.configuration;
      const expected = () => ({
        expectedVersion: current.version,
        expectedIntegrationVersion: current.integration.version,
        expectedControlVersion: current.controlVersion
      });
      const impactPreview = (
        await call("prepare_enterprise_workflow_change", {
          ...reviewSelector,
          ...expected(),
          change: {
            kind: "integration",
            configuration: { ...originalIntegration, storeMappings: [] }
          }
        })
      ).json();
      expect(impactPreview.impact).toEqual({
        affectedWorkflows: [
          { workflowType: "meituan-daily-ingestion", storeNames: ["Store A"] },
          { workflowType: "meituan-review-operations", storeNames: ["Store A"] }
        ]
      });
      expect((await check(makeIntent("preview-only", recipients.slice(1, 2)))).statusCode).toBe(
        200
      );
      const daily = (await call("get_enterprise_workflow", selector)).json();
      const dailyExpected = {
        expectedVersion: daily.version,
        expectedIntegrationVersion: daily.integration.version,
        expectedControlVersion: daily.controlVersion
      };
      const dailyPreview = (
        await call("prepare_enterprise_workflow_change", {
          ...selector,
          ...dailyExpected,
          change: { kind: "configuration", configuration: daily.configuration }
        })
      ).json();
      expect(
        (
          await call("save_enterprise_workflow", {
            ...selector,
            ...dailyExpected,
            previewId: dailyPreview.previewId,
            confirmationDigest: dailyPreview.confirmationDigest
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await call("save_enterprise_workflow", {
            ...reviewSelector,
            ...expected(),
            previewId: impactPreview.previewId,
            confirmationDigest: impactPreview.confirmationDigest
          })
        ).statusCode
      ).toBe(409);
      await change({
        kind: "integration",
        configuration: {
          ...originalIntegration,
          storeMappings: originalIntegration.storeMappings.filter(
            (m: { source: { product: string } }) => m.source.product !== "meituan_reviews"
          )
        }
      });
      binding.controlVersion = current.controlVersion;
      expect(
        (
          await call("manage_workflow_run", {
            workflowId,
            operation: { kind: "resume", ...binding }
          })
        ).statusCode
      ).toBe(200);
      expect((await check(makeIntent("removed-source", recipients.slice(1, 2)))).statusCode).toBe(
        403
      );
      await change({ kind: "integration", configuration: originalIntegration });
      expect((await check(makeIntent("restored-source", recipients.slice(1, 2)))).statusCode).toBe(
        403
      );
      await change({ kind: "control", state: "paused", reason: "Stop external actions" });
      const lateReceipt = {
        ...receipt,
        actionId: "email-remainder",
        receiptId: "gmail-late-receipt",
        providerReadback: {
          ...proof,
          identityHash: remainder.json().actions[0].identityHash,
          correlationMarker: "email-remainder",
          providerReceiptId: "gmail-late-receipt"
        }
      };
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [lateReceipt] })).statusCode
      ).toBe(200);
      expect(
        (
          await action({
            kind: "intent",
            ...binding,
            actions: [makeIntent("after-pause", recipients)]
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await call("manage_workflow_run", {
            workflowId,
            operation: { kind: "release", ...binding }
          })
        ).statusCode
      ).toBe(200);
      await change({ kind: "control", state: "active", reason: "Explicit resume after pause" });
      expect(
        (
          await call("manage_workflow_run", {
            workflowId,
            operation: { kind: "resume", ...binding }
          })
        ).statusCode
      ).toBe(409);
      binding.controlVersion = current.controlVersion;
      const reactivated = await call("manage_workflow_run", {
        workflowId,
        operation: { kind: "resume", ...binding }
      });
      expect(reactivated.statusCode, reactivated.body).toBe(200);
      expect(reactivated.json().snapshot).toEqual(started.json().snapshot);
      const summary = {
        phase: "finished",
        status: "partial",
        observations: [],
        unresolved: [],
        cleanup: "retained"
      };
      expect(
        (
          await call("manage_workflow_run", {
            workflowId,
            operation: { kind: "finish", ...binding, summary }
          })
        ).statusCode
      ).toBe(200);
      const nextRun = await call("manage_workflow_run", {
        workflowId,
        operation: {
          kind: "start",
          installationId: binding.installationId,
          assignmentEpoch: binding.assignmentEpoch,
          expectedConfigurationVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion,
          workflowPackageVersion: "1.0.3",
          window,
          mode: "scheduled"
        }
      });
      expect(nextRun.statusCode, nextRun.body).toBe(200);
      const nextBinding = { ...binding, runId: nextRun.json().runId };
      expect((await check(publishIntent, nextBinding)).statusCode).toBe(200);
      expect(
        (await check(makeIntent("new-run-recipient", recipients.slice(0, 1)), nextBinding))
          .statusCode
      ).toBe(200);
    });
    it("allows admin configuration but requires current business grants before a report reads data", async () => {
      const weeklyPlannerFixture: {
        reportWindow: { startDate: string; endDate: string };
        storeNames: string[];
        extracts: Array<{ dataset: string; startDate: string; endDate: string }>;
      } = JSON.parse(
        await readFile(
          new URL("./weekly-planner-eligibility.fixture.json", import.meta.url),
          "utf8"
        )
      );
      const beforeWeeklyClock = testClock;
      testClock = new Date("2026-07-27T06:00:00.000Z");
      const reportStores = weeklyPlannerFixture.storeNames;
      await prisma.businessStore.createMany({
        data: reportStores.map((name) => ({
          orgId: actor.orgId,
          enterpriseKey: "enterprise",
          name
        }))
      });
      const weekly = { enterpriseKey: "enterprise", workflowType: "weekly-business-report" };
      const shared = (await call("get_enterprise_workflow", selector)).json().integration;
      let current = { version: 0, controlVersion: 0, integration: shared, workflowId: "" };
      const change = async (value: unknown) => {
        const expected = {
          expectedVersion: current.version,
          expectedIntegrationVersion: current.integration.version,
          expectedControlVersion: current.controlVersion
        };
        const preview = (
          await call("prepare_enterprise_workflow_change", {
            ...weekly,
            ...expected,
            change: value
          })
        ).json();
        const saved = await call("save_enterprise_workflow", {
          ...weekly,
          ...expected,
          previewId: preview.previewId,
          confirmationDigest: preview.confirmationDigest
        });
        expect(saved.statusCode, saved.body).toBe(200);
        current = saved.json();
      };
      await change({
        kind: "configuration",
        configuration: {
          schemaVersion: 1,
          type: weekly.workflowType,
          storeNames: reportStores,
          notificationPolicy: "action_required",
          groups: [{ name: "Synthetic group", storeNames: [reportStores[0]!] }],
          delivery: { enabled: false, recipients: [] },
          cleanupPolicy: "retain_final_report"
        }
      });
      await change({
        kind: "authorization",
        grant: [{ kind: "download", datasets: ["business", "dishes"], storeNames: reportStores }],
        revokeAuthorizationIds: []
      });
      await change({ kind: "control", state: "active", reason: "Synthetic report setup" });
      const workflowId = current.workflowId;
      const install = (operation: unknown) =>
        call("manage_workflow_installation", { workflowId, operation });
      await install({
        kind: "register",
        installation: {
          installationId: "weekly-mac",
          deviceAlias: "Report Mac",
          host: "codex",
          platform: "macos",
          launcherVersion: "0.16.0",
          workflowPackageVersion: "1.0.3",
          hostSnapshot: {
            host: "codex",
            platform: "macos",
            taskId: "weekly-task",
            projectRef: "project",
            cron: "30 5 * * 1",
            timezone: "Asia/Shanghai",
            model: "available-model",
            reasoningEffort: "high",
            state: "paused",
            verifiedAt: testClock.toISOString()
          }
        }
      });
      await install({
        kind: "record_checks",
        installationId: "weekly-mac",
        firstRunVerification: "not_run",
        checks: [
          "configuration",
          "permissions",
          "workspace",
          "dependencies",
          "host_schedule",
          "host_timezone",
          "host_model",
          "download"
        ].map((capability) => ({
          capability,
          status: "ready",
          nextStep: "",
          checkedAt: testClock.toISOString()
        }))
      });
      const takeover = (
        await install({
          kind: "prepare_takeover",
          installationId: "weekly-mac",
          expectedAssignmentEpoch: 0,
          oldHostState: "paused"
        })
      ).json();
      await install({
        kind: "takeover",
        installationId: "weekly-mac",
        expectedAssignmentEpoch: 0,
        previewId: takeover.previewId,
        confirmationDigest: takeover.confirmationDigest
      });
      const start = {
        kind: "start",
        installationId: "weekly-mac",
        assignmentEpoch: 1,
        expectedConfigurationVersion: current.version,
        expectedIntegrationVersion: current.integration.version,
        expectedControlVersion: current.controlVersion,
        workflowPackageVersion: "1.0.3",
        window: weeklyPlannerFixture.reportWindow,
        mode: "scheduled"
      };
      const denied = await call("manage_workflow_run", { workflowId, operation: start });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("WORKFLOW_PERMISSION_DENIED");
      expect((await call("get_workflow_status", { workflowId })).json().runs).toHaveLength(0);
      await prisma.businessCategory.createMany({
        data: ["business", "dishes"].map((key) => ({
          orgId: actor.orgId,
          id: key,
          key,
          name: key,
          kind: "fixed" as const,
          confidentialityLevel: 1,
          allowGroup: false,
          allowStore: true
        }))
      });
      await createBusinessAuthorizationRepository({ prisma }).configureAccount({
        orgId: actor.orgId,
        actorId: actor.id,
        employeeId: actor.id,
        expectedVersion: String(
          (
            await prisma.businessAuthorizationState.findUniqueOrThrow({
              where: { orgId: actor.orgId }
            })
          ).version
        ),
        clearance: 3,
        grants: [
          {
            id: "report-read-grant",
            orgId: actor.orgId,
            enterpriseKey: "enterprise",
            categoryIds: ["business", "dishes"],
            ownership: "store",
            stores: { kind: "fixed", values: reportStores },
            dimensions: {}
          }
        ]
      });
      const allowedWindow = (await call("get_workflow_status", { workflowId })).json()
        .expectedWindow;
      const allowed = await call("manage_workflow_run", {
        workflowId,
        operation: { ...start, window: allowedWindow }
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
      const binding = {
        runId: allowed.json().runId,
        installationId: "weekly-mac",
        assignmentEpoch: 1,
        controlVersion: current.controlVersion
      };
      const action = (operation: unknown) =>
        call("record_workflow_action", { workflowId, operation });
      const downloadIntent = {
        actionId: "range-download",
        identity: {
          kind: "download",
          dataset: "business",
          storeNames: reportStores,
          window: allowedWindow
        }
      };
      const checkDownload = (
        dataset: string,
        window: { startDate: string; endDate: string },
        storeNames = reportStores
      ) =>
        call("manage_workflow_run", {
          workflowId,
          operation: {
            kind: "check_actions",
            ...binding,
            actions: [
              {
                ...downloadIntent,
                identity: { ...downloadIntent.identity, dataset, window, storeNames }
              }
            ]
          }
        });
      expect(allowedWindow).toEqual(weeklyPlannerFixture.reportWindow);
      // Literal planner result: min(52weeks, prior52weeks, prior daily year, prior full-month year).
      const history = { startDate: "2024-07-01", endDate: "2026-07-26" };
      expect(weeklyPlannerFixture.storeNames).toHaveLength(2);
      expect(weeklyPlannerFixture.extracts).toHaveLength(28);
      expect(
        weeklyPlannerFixture.extracts.filter((extract) => extract.dataset === "business")
      ).toHaveLength(25);
      // Captured actual business-analysis planner output, including monthly chunks and3 dishes comparisons.
      const planned = await call("manage_workflow_run", {
        workflowId,
        operation: {
          kind: "check_actions",
          ...binding,
          actions: weeklyPlannerFixture.extracts.map((extract, index) => ({
            actionId: `planned-${index}`,
            identity: {
              kind: "download",
              dataset: extract.dataset,
              storeNames: reportStores,
              window: { startDate: extract.startDate, endDate: extract.endDate }
            }
          }))
        }
      });
      expect(planned.statusCode, planned.body).toBe(200);
      expect((await checkDownload("business", history)).statusCode).toBe(200);
      expect(
        (await checkDownload("business", { startDate: "2024-07-01", endDate: "2024-07-31" }))
          .statusCode
      ).toBe(200);
      expect(
        (await checkDownload("business", { ...history, startDate: "2024-06-30" })).statusCode
      ).toBe(403);
      expect(
        (await checkDownload("business", { ...history, endDate: "2026-07-27" })).statusCode
      ).toBe(403);
      expect((await checkDownload("business", history, ["Unselected Store"])).statusCode).toBe(403);
      expect((await checkDownload("dishes", history)).statusCode).toBe(403);
      expect((await checkDownload("in_store_orders", history)).statusCode).toBe(403);
      expect(
        (await checkDownload("dishes", { startDate: "2026-07-13", endDate: "2026-07-19" }))
          .statusCode
      ).toBe(200);
      const claimed = await action({ kind: "intent", ...binding, actions: [downloadIntent] });
      expect(claimed.statusCode, claimed.body).toBe(200);
      expect(claimed.json().actions[0].permitted).toBe(true);
      const transferReceipt = {
        actionId: "range-download",
        state: "confirmed",
        evidence: "launcher_transfer",
        receiptId: "local-transfer-receipt",
        resultHash: "b".repeat(64),
        verifiedAt: testClock.toISOString(),
        launcherTransfer: {
          identityHash: claimed.json().actions[0].identityHash,
          manifestHash: "a".repeat(64),
          resultHash: "b".repeat(64),
          launcherVersion: "0.16.0",
          verifiedAt: testClock.toISOString(),
          partitionCount: 1,
          fileCount: 1,
          totalByteSize: "10",
          totalRowCount: "1"
        }
      };
      expect(
        (
          await action({
            kind: "record_receipts",
            ...binding,
            receipts: [
              {
                ...transferReceipt,
                launcherTransfer: {
                  ...transferReceipt.launcherTransfer,
                  identityHash: "0".repeat(64)
                }
              }
            ]
          })
        ).statusCode
      ).toBe(409);
      const recovered = await callMcp("record_workflow_action", {
        workflowId,
        operation: { kind: "record_receipts", ...binding, receipts: [transferReceipt] }
      });
      expect(recovered.isError, recovered.content[0].text).toBe(false);
      // A later safe read must refresh the source, even for exactly the same date/store scope.
      const fresh = await action({
        kind: "intent",
        ...binding,
        actions: [{ ...downloadIntent, actionId: "fresh-range-download" }]
      });
      expect(fresh.json().actions[0].permitted).toBe(true);
      await createBusinessAuthorizationRepository({ prisma }).configureAccount({
        orgId: actor.orgId,
        actorId: actor.id,
        employeeId: actor.id,
        expectedVersion: String(
          (
            await prisma.businessAuthorizationState.findUniqueOrThrow({
              where: { orgId: actor.orgId }
            })
          ).version
        ),
        clearance: 3,
        grants: []
      });
      expect(
        (
          await action({
            kind: "intent",
            ...binding,
            actions: [{ ...downloadIntent, actionId: "revoked-range-download" }]
          })
        ).statusCode
      ).toBe(403);
      expect((await checkDownload("business", history)).statusCode).toBe(403);
      testClock = new Date(beforeWeeklyClock.getTime() + 91 * 86400000);
      const weeklyHost = (await call("get_workflow_status", { workflowId })).json().installations[0]
        .hostSnapshot;
      const observedSchedule = await install({
        kind: "record_host",
        installationId: "weekly-mac",
        hostSnapshot: {
          ...weeklyHost,
          state: "enabled",
          cron: "RRULE:FREQ=WEEKLY;BYHOUR=5;BYMINUTE=30;BYDAY=MO"
        }
      });
      expect(observedSchedule.statusCode, observedSchedule.body).toBe(200);
      expect((await call("get_workflow_status", { workflowId })).json().possibleMissedWindow).toBe(
        true
      );
      const daily = (await call("get_enterprise_workflow", selector)).json();
      const retained = (await call("get_workflow_status", { workflowId: daily.workflowId })).json();
      expect(
        retained.runs.every((run: { finishedAt: string | null }) => run.finishedAt === null)
      ).toBe(true);
      const historical = (
        await call("record_workflow_action", {
          workflowId: daily.workflowId,
          operation: { kind: "get", actionIds: ["upload-action"] }
        })
      ).json();
      expect(historical.actions[0].state).toBe("confirmed");
    });
  }
);
