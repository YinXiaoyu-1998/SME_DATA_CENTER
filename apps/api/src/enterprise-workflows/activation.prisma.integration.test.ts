import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabaseAdapter } from "@smedc/db";
import { type AuthenticatedEmployee } from "@smedc/domain";
import { ORDER_SCOPE_ROLLBACK_PROBE } from "../../../../scripts/deploy-staging.js";
import { createOwnedIntegrationDatabase } from "../../../../scripts/test-integration-support.js";
import { buildApiServer } from "../server.js";
import { createEnterpriseWorkflowService } from "./service.js";

describe.skipIf(process.env["RUN_WORKFLOW_INTEGRATION"] !== "1")(
  "enterprise workflow order source cutover",
  () => {
    let database: Awaited<ReturnType<typeof createOwnedIntegrationDatabase>>;
    let prisma: PrismaClient;
    let app: ReturnType<typeof buildApiServer>;
    const testClock = new Date();
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
      datasets: ["in_store_orders"],
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
      await prisma.userAccount.create({
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
        data: {
          orgId: actor.orgId,
          enterpriseKey: "enterprise",
          name: "Store A",
          officialName: "Store A",
          confirmation: "confirmed"
        }
      });
      app = buildApiServer({
        logger: false,
        runtimeEnv: { ...process.env, DATABASE_URL: database.databaseUrl },
        cursorSigningSecret: "synthetic-test-secret",
        authenticateAccessToken: async () => actor,
        enterpriseWorkflowService: createEnterpriseWorkflowService({
          prisma,
          now: () => testClock
        })
      });
      await app.ready();
    }, 60000);
    afterAll(async () => {
      await app?.close();
      await prisma?.$disconnect();
      await database?.cleanup();
    });
    const change = async (workflowType: string, value: unknown) => {
      const selected = { ...selector, workflowType };
      const response = await call("get_enterprise_workflow", selected);
      const current = response.statusCode === 200 ? response.json() : undefined;
      const expected = {
        expectedVersion: current?.version ?? 0,
        expectedIntegrationVersion:
          current?.integration.version ??
          (await call("get_enterprise_workflow", selector)).json().integration?.version ??
          0,
        expectedControlVersion: current?.controlVersion ?? 0
      };
      const preview = await call("prepare_enterprise_workflow_change", {
        ...selected,
        ...expected,
        change: value
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const saved = await call("save_enterprise_workflow", {
        ...selected,
        ...expected,
        previewId: preview.json().previewId,
        confirmationDigest: preview.json().confirmationDigest
      });
      expect(saved.statusCode, saved.body).toBe(200);
      return saved.json();
    };
    const current = async () => (await call("get_enterprise_workflow", selector)).json();
    const probeRollback = (databaseUrl = database.databaseUrl) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", ORDER_SCOPE_ROLLBACK_PROBE], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe"
      });
    it("permits legacy rollback but rejects partial schema and pending scoped imports", async () => {
      const legacy = await createOwnedIntegrationDatabase(
        process.env["DATABASE_URL"]!,
        process.env["MYSQL_PORT"]!
      );
      const legacyPrisma = new PrismaClient({ adapter: createDatabaseAdapter(legacy.databaseUrl) });
      try {
        await legacyPrisma.$executeRawUnsafe("CREATE TABLE structured_partitions (id INT)");
        await legacyPrisma.$executeRawUnsafe(
          "CREATE TABLE partition_import_jobs (id INT, status VARCHAR(32) DEFAULT 'uploading')"
        );
        expect(() => probeRollback(legacy.databaseUrl)).not.toThrow();
        await legacyPrisma.$executeRawUnsafe(
          "ALTER TABLE structured_partitions ADD COLUMN order_scope VARCHAR(32)"
        );
        expect(() => probeRollback(legacy.databaseUrl)).toThrow();
        await legacyPrisma.$executeRawUnsafe(
          "CREATE TABLE enterprise_integrations (order_scope_required BOOLEAN)"
        );
        await legacyPrisma.$executeRawUnsafe(
          "ALTER TABLE partition_import_jobs ADD COLUMN order_scope VARCHAR(32)"
        );
        expect(() => probeRollback(legacy.databaseUrl)).not.toThrow();
        await legacyPrisma.$executeRawUnsafe(
          "INSERT INTO partition_import_jobs (id, order_scope) VALUES (?, ?)",
          1,
          "settled_only"
        );
        expect(() => probeRollback(legacy.databaseUrl)).toThrow();
        await legacyPrisma.$executeRawUnsafe(
          "UPDATE partition_import_jobs SET status = ?",
          "rejected"
        );
        expect(() => probeRollback(legacy.databaseUrl)).not.toThrow();
      } finally {
        await legacyPrisma.$disconnect();
        await legacy.cleanup();
      }
    });
    it("allows legacy rollback for unknown historical sources but blocks explicit source metadata", async () => {
      // The release command observes fixture state through its real database boundary.
      await prisma.structuredPartition.create({
        data: {
          id: "scope_fixture",
          orgId: actor.orgId,
          enterpriseKey: "enterprise",
          enterpriseName: "Synthetic",
          dataset: "in_store_orders",
          storeKey: "store-a",
          storeName: "Store A",
          businessDate: new Date("2026-10-01"),
          objectKey: "synthetic/scope-fixture.csv",
          rowCount: 1,
          byteSize: 1,
          checksumSha256: "a".repeat(64),
          confidentialityLevel: 0,
          publishedByJobId: "synthetic",
          orderScope: "legacy_unknown"
        }
      });
      try {
        expect(() => probeRollback()).not.toThrow();
        for (const orderScope of ["settled_only", "all_statuses"] as const) {
          await prisma.structuredPartition.update({
            where: { id: "scope_fixture" },
            data: { orderScope }
          });
          expect(() => probeRollback()).toThrow();
        }
      } finally {
        await prisma.structuredPartition.delete({ where: { id: "scope_fixture" } });
      }
    });
    it("keeps legacy order uploads compatible when reports, reviews or unprepared ingestion are allowed", async () => {
      expect(() => probeRollback()).not.toThrow();
      await change(selector.workflowType, { kind: "configuration", configuration });
      await change(selector.workflowType, {
        kind: "integration",
        configuration: {
          schemaVersion: 1,
          timezone: "Asia/Shanghai",
          sourceAccounts: ["meituan_erp", "meituan_reviews"].map((product) => ({
            product,
            accountRef: product,
            displayName: "Synthetic",
            sourceEnterpriseName: "Synthetic"
          })),
          storeMappings: ["meituan_erp", "meituan_reviews"].map((product) => ({
            storeName: "Store A",
            source: {
              product,
              channel: product === "meituan_erp" ? "erp" : "meituan",
              accountRef: product,
              sourceStoreId: "poi",
              sourceStoreName: "Source Store"
            }
          })),
          exclusions: []
        }
      });
      for (const config of [
        {
          schemaVersion: 1,
          type: "weekly-business-report",
          storeNames: ["Store A"],
          notificationPolicy: "action_required",
          groups: [],
          delivery: { enabled: false, recipients: [] },
          cleanupPolicy: "retain_final_report"
        },
        {
          schemaVersion: 1,
          type: "meituan-review-operations",
          storeNames: ["Store A"],
          notificationPolicy: "action_required",
          executionPolicy: { id: "verified-review-operations", version: 1 },
          ignoredReviewIdentities: [],
          channels: ["meituan"],
          publication: { enabled: false, storeNames: [] },
          brandFacts: "Synthetic",
          tone: "Friendly",
          draftNotification: { enabled: false, recipients: [] },
          cleanupPolicy: "complete_run_only"
        }
      ]) {
        await change(config.type, { kind: "configuration", configuration: config });
        await change(config.type, {
          kind: "control",
          state: "active",
          reason: "Synthetic approval"
        });
        expect((await current()).integration.orderScopeRequired).toBe(false);
      }
      await change(selector.workflowType, {
        kind: "control",
        state: "active",
        reason: "Synthetic approval"
      });
      expect((await current()).integration.orderScopeRequired).toBe(false);
    });
    it("cuts over only a ready assigned daily ingestion installation selecting in-store orders and never reverses it", async () => {
      const { workflowId } = await current();
      const install = async (operation: unknown, status = 200) => {
        const response = await call("manage_workflow_installation", { workflowId, operation });
        expect(response.statusCode, response.body).toBe(status);
        return response.json();
      };
      await install({
        kind: "register",
        installation: {
          installationId: "mac",
          deviceAlias: "Synthetic Mac",
          host: "codex",
          platform: "macos",
          launcherVersion: "0.16.0",
          workflowPackageVersion: "1.0.0"
        }
      });
      await install(
        {
          kind: "prepare_takeover",
          installationId: "mac",
          expectedAssignmentEpoch: 0,
          oldHostState: "paused"
        },
        409
      );
      expect((await current()).integration.orderScopeRequired).toBe(false);
      await install({
        kind: "record_host",
        installationId: "mac",
        hostSnapshot: {
          host: "codex",
          platform: "macos",
          taskId: "task",
          projectRef: "project",
          cron: "45 3 * * *",
          timezone: "Asia/Shanghai",
          model: "available-model",
          reasoningEffort: "high",
          state: "paused",
          verifiedAt: testClock.toISOString()
        }
      });
      await install({
        kind: "record_checks",
        installationId: "mac",
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
          "meituan_erp"
        ].map((capability) => ({
          capability,
          status: "ready",
          nextStep: "",
          checkedAt: testClock.toISOString()
        }))
      });
      await change(selector.workflowType, {
        kind: "configuration",
        configuration: { ...configuration, datasets: ["business"] }
      });
      const preview = await install({
        kind: "prepare_takeover",
        installationId: "mac",
        expectedAssignmentEpoch: 0,
        oldHostState: "paused"
      });
      await install({
        kind: "takeover",
        installationId: "mac",
        expectedAssignmentEpoch: 0,
        previewId: preview.previewId,
        confirmationDigest: preview.confirmationDigest
      });
      expect((await current()).integration.orderScopeRequired).toBe(false);
      await change(selector.workflowType, {
        kind: "control",
        state: "paused",
        reason: "Prepare paused handoff"
      });
      await change(selector.workflowType, { kind: "configuration", configuration });
      expect((await current()).integration.orderScopeRequired).toBe(false);
      const pausedTakeover = await install({
        kind: "prepare_takeover",
        installationId: "mac",
        expectedAssignmentEpoch: 1,
        oldHostState: "paused"
      });
      await install({
        kind: "takeover",
        installationId: "mac",
        expectedAssignmentEpoch: 1,
        previewId: pausedTakeover.previewId,
        confirmationDigest: pausedTakeover.confirmationDigest
      });
      expect((await current()).integration.orderScopeRequired).toBe(false);
      await change(selector.workflowType, {
        kind: "control",
        state: "active",
        reason: "Permit prepared handoff"
      });
      expect((await current()).integration.orderScopeRequired).toBe(false);
      const installation = await install({
        kind: "record_checks",
        installationId: "mac",
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
          "meituan_erp"
        ].map((capability) => ({
          capability,
          status: "ready",
          nextStep: "",
          checkedAt: testClock.toISOString()
        }))
      });
      await install({
        kind: "set_state",
        installationId: "mac",
        expectedVersion: installation.version,
        state: "enabled",
        reason: "Synthetic enable"
      });
      expect((await current()).integration.orderScopeRequired).toBe(true);
      expect(() => probeRollback()).toThrow();
      await change(selector.workflowType, {
        kind: "control",
        state: "paused",
        reason: "Synthetic pause"
      });
      await change(selector.workflowType, {
        kind: "control",
        state: "revoked",
        reason: "Synthetic revoke"
      });
      expect((await current()).integration.orderScopeRequired).toBe(true);
    });
  }
);
