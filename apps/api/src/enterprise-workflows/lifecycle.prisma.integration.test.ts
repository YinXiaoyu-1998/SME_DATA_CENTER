import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createBusinessAuthorizationRepository, createDatabaseAdapter } from "@smedc/db";
import { workflowCanonicalJson, type AuthenticatedEmployee } from "@smedc/domain";
import { createOwnedIntegrationDatabase } from "../../../../scripts/test-integration-support.js";
import { buildApiServer } from "../server.js";
import { createEnterpriseWorkflowService } from "./service.js";

describe.skipIf(process.env["RUN_WORKFLOW_INTEGRATION"] !== "1")(
  "enterprise workflow public lifecycle",
  () => {
    let database: Awaited<ReturnType<typeof createOwnedIntegrationDatabase>>;
    let prisma: PrismaClient;
    let app: ReturnType<typeof buildApiServer>;
    let testClock = new Date();
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
        data: { orgId: actor.orgId, enterpriseKey: "enterprise", enterpriseName: "Synthetic" }
      });
      await prisma.businessStore.create({
        data: { orgId: actor.orgId, enterpriseKey: "enterprise", name: "Store A" }
      });
      app = buildApiServer({
        logger: false,
        cursorSigningSecret: "synthetic-test-secret",
        authenticateAccessToken: async () => actor,
        enterpriseWorkflowService: createEnterpriseWorkflowService({ prisma, now: () => testClock })
      });
      await app.ready();
    }, 60000);
    afterAll(async () => {
      await app?.close();
      await prisma?.$disconnect();
      await database?.cleanup();
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
          minimumLauncherVersion: "0.16.0"
        },
        needsConfiguration: true,
        setupUrl: "/admin/permissions/workflow_org/workflows/enterprise"
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
        workflowPackageVersion: "1.0.0"
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
      const takeover = await install({
        kind: "prepare_takeover",
        installationId: "mac-a",
        expectedAssignmentEpoch: 0,
        oldHostState: "paused"
      });
      expect(takeover.statusCode).toBe(200);
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
        workflowPackageVersion: "1.0.0",
        window: { startDate: previous, endDate: previous },
        mode: "scheduled"
      };
      const racing = await Promise.all([
        call("manage_workflow_run", { workflowId, operation: start }),
        call("manage_workflow_run", { workflowId, operation: start })
      ]);
      expect(racing.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const run = racing.find((response) => response.statusCode === 200)!;
      expect(run.json()).toMatchObject({
        snapshot: { configurationVersion: 1, configuration },
        assignmentEpoch: 1
      });
      expect((await call("manage_workflow_run", { workflowId, operation: start })).statusCode).toBe(
        409
      );
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
      await prisma.employee.update({ where: { id: actor.id }, data: { role: "employee" } });
      expect((await action({ kind: "get", actionIds: ["upload-action"] })).statusCode).toBe(403);
      await prisma.employee.update({ where: { id: actor.id }, data: { role: "admin" } });
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
      const prepared = await install({ kind: "migration_preview", manifest });
      expect(prepared.statusCode, prepared.body).toBe(200);
      let migration = prepared.json();
      expect((await install({ kind: "migration_preview", manifest })).json().migrationId).toBe(
        migration.migrationId
      );
      const chunk = [{ workflowId, completedActions: [completion(101)], unresolved: [] }];
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
      expect(migration.recordCount).toBe(101);
      const page = (
        await install({ kind: "migration_get", migrationId: migration.migrationId })
      ).json();
      expect(page.nextCursor).toBe(1);
      expect(page.chunks[0].chunk[0].completedActions).toHaveLength(100);
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
          recordCount: 101,
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
        recordCount: 101,
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
    });
    it("exposes controlled MCP reads and rejects stale roles, disabled accounts and foreign tenants", async () => {
      let rpcId = 100;
      const mcp = async (name: string, args: unknown) => {
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
          payload: JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId++,
            method: "tools/call",
            params: { name, arguments: args }
          })
        });
        expect(response.statusCode, response.body).toBe(200);
        const envelope = response.json();
        expect(envelope.error, response.body).toBeUndefined();
        expect(envelope.result.isError, response.body).not.toBe(true);
        return JSON.parse(envelope.result.content[0].text);
      };
      const state = await mcp("get_enterprise_workflow", selector);
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
      await prisma.employee.update({ where: { id: actor.id }, data: { disabled: true } });
      expect((await call("get_enterprise_workflow", selector)).statusCode).toBe(403);
      await prisma.employee.update({ where: { id: actor.id }, data: { disabled: false } });
      const originalOrg = actor.orgId;
      actor.orgId = "foreign-org";
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
            workflowPackageVersion: "1.0.0",
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
              workflowPackageVersion: "1.0.0",
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
        workflowPackageVersion: "1.0.0",
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
      await change({
        kind: "authorization",
        grant: [
          { kind: "review_publish", channels: ["meituan"], storeNames: ["Store A"] },
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
          workflowPackageVersion: "1.0.0",
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
          workflowPackageVersion: "1.0.0",
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
      await change({ kind: "control", state: "paused", reason: "Stop external actions" });
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
    });
    it("allows admin configuration but requires current business grants before a report reads data", async () => {
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
          storeNames: ["Store A"],
          notificationPolicy: "action_required",
          groups: [{ name: "Synthetic group", storeNames: ["Store A"] }],
          delivery: { enabled: false, recipients: [] },
          cleanupPolicy: "retain_final_report"
        }
      });
      await change({
        kind: "authorization",
        grant: [{ kind: "download", datasets: ["business", "dishes"], storeNames: ["Store A"] }],
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
          workflowPackageVersion: "1.0.0",
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
        workflowPackageVersion: "1.0.0",
        window: { startDate: "2026-10-26", endDate: "2026-11-01" },
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
        expectedVersion: "0",
        clearance: 3,
        grants: [
          {
            id: "report-read-grant",
            orgId: actor.orgId,
            enterpriseKey: "enterprise",
            categoryIds: ["business", "dishes"],
            ownership: "store",
            stores: { kind: "fixed", values: ["Store A"] },
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
          storeNames: ["Store A"],
          window: allowedWindow
        }
      };
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
      expect(
        (await action({ kind: "record_receipts", ...binding, receipts: [transferReceipt] }))
          .statusCode
      ).toBe(200);
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
        expectedVersion: "1",
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
      testClock = new Date(testClock.getTime() + 91 * 86400000);
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
