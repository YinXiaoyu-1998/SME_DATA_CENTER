import { z } from "zod";
import {
  workflowHostSnapshotSchema,
  workflowMigrationManifestSchema,
  workflowMigrationChunkSchema,
  workflowActionIdentitySchema,
  workflowActionReceiptSchema,
  type WorkflowMigrationChunk
} from "@smedc/domain";
import type { WorkflowMcpInputs } from "@smedc/mcp-contract";
import {
  audit,
  dbType,
  fail,
  hash,
  id,
  json,
  type Actor,
  type Tx,
  type Workflow
} from "./repository.js";
import { integration, validateConfiguration, validateStores } from "./configuration.js";
import { deduplicationKeys } from "./actions.js";
const targetsSchema = z.array(
  z
    .object({
      workflowId: z.string(),
      version: z.number(),
      controlVersion: z.number(),
      assignmentEpoch: z.number()
    })
    .strict()
);
const records = (chunk: WorkflowMigrationChunk) =>
  chunk.reduce(
    (n, w) => n + w.completedActions.length + w.unresolved.length + (w.recoveryItems?.length ?? 0),
    0
  );
const digestStart = "0".repeat(64);
const nextDigest = (previous: string, sequence: number, digest: string, count: number) =>
  hash([previous, sequence, digest, count]);
const migrationView = (row: { id: string; manifest: unknown; [key: string]: unknown }) => {
  const manifest = workflowMigrationManifestSchema.parse(row.manifest);
  return {
    ...row,
    migrationId: row.id,
    manifest: {
      ...manifest,
      workflows: manifest.workflows.map((w) => ({
        ...w,
        completedActions: [],
        unresolved: [],
        ...(w.recoveryItems !== undefined ? { recoveryItems: [] } : {})
      }))
    }
  };
};
export async function migrationSummaries(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  cursor: string | undefined,
  limit: number
) {
  // Apply tenant, enterprise and complete manifest membership before the page limit.
  // Select only bounded metadata; configuration/history lives in migration_get pages.
  const rows = await tx.workflowMigration.findMany({
    where: {
      orgId: actor.orgId,
      enterpriseKey: workflow.enterpriseKey,
      manifest: { path: "$.workflows[*].workflowId", array_contains: workflow.id },
      ...(cursor ? { id: { lt: cursor } } : {})
    },
    orderBy: { id: "desc" },
    take: limit + 1,
    select: {
      id: true,
      stage: true,
      version: true,
      sourceSnapshotHash: true,
      targetVersion: true,
      chunkCount: true,
      recordCount: true,
      chunksDigest: true,
      validatedChunks: true,
      importedChunks: true,
      targetVersions: true,
      createdAt: true,
      updatedAt: true
    }
  });
  return {
    migrations: rows.slice(0, limit).map(({ id, targetVersions, ...metadata }) => ({
      migrationId: id,
      ...metadata,
      workflowIds: targetsSchema.parse(targetVersions).map((item) => item.workflowId)
    })),
    nextMigrationCursor: rows.length > limit ? rows[limit - 1]!.id : null
  };
}
export async function migrationOperation(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  op: WorkflowMcpInputs["manage_workflow_installation"]["operation"],
  now: Date
) {
  if (op.kind === "migration_preview") {
    const manifest = op.manifest;
    const prior = await tx.workflowMigration.findUnique({
      where: {
        orgId_enterpriseKey_sourceSnapshotHash_targetVersion: {
          orgId: actor.orgId,
          enterpriseKey: workflow.enterpriseKey,
          sourceSnapshotHash: manifest.sourceSnapshotHash,
          targetVersion: manifest.targetVersion
        }
      }
    });
    if (prior) {
      if (hash(prior.manifest) !== hash(manifest)) fail("WORKFLOW_VERSION_CONFLICT");
      return migrationView(prior);
    }
    const shared = await integration(tx, workflow);
    if (shared.version !== manifest.targetVersion) fail("WORKFLOW_VERSION_CONFLICT");
    await validateStores(
      tx,
      workflow,
      manifest.integration.storeMappings.map((m) => m.storeName)
    );
    const targets = [];
    for (const item of [...manifest.workflows].sort((a, b) =>
      a.workflowId.localeCompare(b.workflowId)
    )) {
      let target = await tx.enterpriseWorkflow.findUnique({
        where: {
          orgId_enterpriseKey_type: {
            orgId: actor.orgId,
            enterpriseKey: workflow.enterpriseKey,
            type: dbType(item.configuration.type)
          }
        }
      });
      if (!target)
        target = await tx.enterpriseWorkflow.create({
          data: {
            id: item.workflowId,
            orgId: actor.orgId,
            enterpriseKey: workflow.enterpriseKey,
            type: dbType(item.configuration.type)
          }
        });
      if (
        target.id !== item.workflowId ||
        target.controlState !== "paused" ||
        (target.leaseExpiresAt && target.leaseExpiresAt > now)
      )
        fail("WORKFLOW_BUSY");
      await validateConfiguration(tx, target, item.configuration, manifest.integration);
      if (
        item.authorizations.some((scope) =>
          scope.storeNames.some((store) => !item.configuration.storeNames.includes(store))
        )
      )
        fail("WORKFLOW_PERMISSION_DENIED");
      targets.push({
        workflowId: target.id,
        version: target.version,
        controlVersion: target.controlVersion,
        assignmentEpoch: target.assignmentEpoch
      });
    }
    const migrationId = id();
    const chunk = workflowMigrationChunkSchema.parse(
      manifest.workflows.map((w) => ({
        workflowId: w.workflowId,
        completedActions: w.completedActions,
        unresolved: w.unresolved,
        ...(w.recoveryItems !== undefined ? { recoveryItems: w.recoveryItems } : {})
      }))
    );
    const chunkHash = hash(chunk);
    const count = records(chunk);
    const confirmationDigest = hash({ migrationId, manifest, targets, actor });
    const row = await tx.workflowMigration.create({
      data: {
        id: migrationId,
        orgId: actor.orgId,
        enterpriseKey: workflow.enterpriseKey,
        sourceSnapshotHash: manifest.sourceSnapshotHash,
        targetVersion: manifest.targetVersion,
        manifest: json(manifest),
        targetVersions: json(targets),
        confirmationDigest,
        createdBy: actor.id,
        chunkCount: 1,
        recordCount: count,
        chunksDigest: nextDigest(digestStart, 0, chunkHash, count)
      }
    });
    await tx.workflowMigrationChunk.create({
      data: {
        orgId: actor.orgId,
        migrationId,
        sequence: 0,
        payload: json(chunk),
        digest: chunkHash,
        recordCount: count
      }
    });
    await audit(tx, actor, "migration_preview", workflow.id, {
      migrationId,
      sourceSnapshotHash: manifest.sourceSnapshotHash
    });
    return migrationView(row);
  }
  if (
    !["migration_append", "migration_seal", "migration_get", "migration_advance"].includes(
      op.kind
    ) ||
    !("migrationId" in op)
  )
    fail("WORKFLOW_PERMISSION_DENIED");
  await tx.$queryRaw`SELECT id FROM workflow_migrations WHERE id = ${op.migrationId} AND org_id = ${actor.orgId} FOR UPDATE`;
  const row = await tx.workflowMigration.findFirst({
    where: { id: op.migrationId, orgId: actor.orgId, enterpriseKey: workflow.enterpriseKey }
  });
  if (!row) fail("WORKFLOW_CONFIGURATION_REQUIRED");
  const manifest = workflowMigrationManifestSchema.parse(row.manifest);
  if (!manifest.workflows.some((item) => item.workflowId === workflow.id))
    fail("WORKFLOW_CONFIGURATION_REQUIRED");
  const targets = targetsSchema.parse(row.targetVersions);
  if (op.kind === "migration_get") {
    const cursor = op.cursor ?? 0;
    const limit = op.limit ?? 1;
    const chunks = await tx.workflowMigrationChunk.findMany({
      where: { orgId: actor.orgId, migrationId: row.id, sequence: { gte: cursor } },
      orderBy: { sequence: "asc" },
      take: limit + 1
    });
    return {
      ...migrationView(row),
      chunks: chunks.slice(0, limit).map((c) => ({
        sequence: c.sequence,
        chunk: workflowMigrationChunkSchema.parse(c.payload),
        chunkHash: c.digest,
        recordCount: c.recordCount,
        importedAt: c.importedAt
      })),
      nextCursor: chunks.length > limit ? chunks[limit]!.sequence : null
    };
  }
  if (op.kind === "migration_append") {
    const existing = await tx.workflowMigrationChunk.findUnique({
      where: {
        orgId_migrationId_sequence: {
          orgId: actor.orgId,
          migrationId: row.id,
          sequence: op.sequence
        }
      }
    });
    if (existing && existing.digest === op.chunkHash && hash(op.chunk) === existing.digest)
      return migrationView(row);
    if (
      row.version !== op.expectedVersion ||
      row.sealedAt ||
      row.stage !== "preview" ||
      op.sequence !== row.chunkCount ||
      hash(op.chunk) !== op.chunkHash ||
      op.chunk.some((w) => !targets.some((t) => t.workflowId === w.workflowId))
    )
      fail("WORKFLOW_VERSION_CONFLICT");
    const count = records(op.chunk);
    await tx.workflowMigrationChunk.create({
      data: {
        orgId: actor.orgId,
        migrationId: row.id,
        sequence: op.sequence,
        payload: json(op.chunk),
        digest: op.chunkHash,
        recordCount: count
      }
    });
    const changed = await tx.workflowMigration.update({
      where: { id: row.id },
      data: {
        chunkCount: { increment: 1 },
        recordCount: { increment: count },
        chunksDigest: nextDigest(row.chunksDigest ?? digestStart, op.sequence, op.chunkHash, count),
        version: { increment: 1 }
      }
    });
    return migrationView(changed);
  }
  if (op.kind === "migration_seal") {
    if (
      row.version !== op.expectedVersion ||
      row.stage !== "preview" ||
      row.sealedAt ||
      row.chunkCount !== op.chunkCount ||
      row.recordCount !== op.recordCount ||
      row.chunksDigest !== op.chunksDigest
    )
      fail("WORKFLOW_VERSION_CONFLICT");
    // Seal the exact ordered chunk manifest: later appends can never race the import.
    const confirmationDigest = hash({
      migrationId: row.id,
      sourceSnapshotHash: row.sourceSnapshotHash,
      targetVersions: row.targetVersions,
      chunksDigest: row.chunksDigest,
      chunkCount: row.chunkCount,
      recordCount: row.recordCount
    });
    return migrationView(
      await tx.workflowMigration.update({
        where: { id: row.id },
        data: { sealedAt: now, confirmationDigest, version: { increment: 1 } }
      })
    );
  }
  if (op.kind !== "migration_advance") fail("WORKFLOW_PERMISSION_DENIED");
  if (
    op.sourceSnapshotHash !== row.sourceSnapshotHash ||
    op.confirmationDigest !== row.confirmationDigest
  )
    fail("WORKFLOW_VERSION_CONFLICT");
  if (row.stage === op.stage) return migrationView(row);
  if (row.version !== op.expectedVersion || !row.sealedAt) fail("WORKFLOW_VERSION_CONFLICT");
  const stages = ["preview", "validated", "imported", "host_switched", "verified"];
  if (stages.indexOf(op.stage) !== stages.indexOf(row.stage) + 1) fail("WORKFLOW_VERSION_CONFLICT");
  if (op.stage === "validated") {
    const page = await tx.workflowMigrationChunk.findUniqueOrThrow({
      where: {
        orgId_migrationId_sequence: {
          orgId: actor.orgId,
          migrationId: row.id,
          sequence: row.validatedChunks
        }
      }
    });
    const chunk = workflowMigrationChunkSchema.parse(page.payload);
    if (
      hash(chunk) !== page.digest ||
      records(chunk) !== page.recordCount ||
      chunk.some((w) =>
        w.unresolved.some((u) => u.code === "source_conflict" || u.code === "missing_receipt")
      )
    )
      fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
    const complete = row.validatedChunks + 1 === row.chunkCount;
    const changed = await tx.workflowMigration.update({
      where: { id: row.id },
      data: {
        validatedChunks: { increment: 1 },
        version: { increment: 1 },
        ...(complete ? { stage: "validated" } : {})
      }
    });
    await audit(tx, actor, "migration_validate", workflow.id, {
      migrationId: row.id,
      sequence: page.sequence,
      complete
    });
    return {
      ...migrationView(changed),
      complete,
      nextSequence: complete ? null : changed.validatedChunks
    };
  }

  if (op.stage === "imported") {
    const shared = await integration(tx, workflow);
    if (shared.version !== row.targetVersion + (row.importedChunks ? 1 : 0))
      fail("WORKFLOW_VERSION_CONFLICT");
    for (const target of targets) {
      await tx.$queryRaw`SELECT id FROM enterprise_workflows WHERE id = ${target.workflowId} AND org_id = ${actor.orgId} FOR UPDATE`;
      const current = await tx.enterpriseWorkflow.findUniqueOrThrow({
        where: { id: target.workflowId }
      });
      if (
        current.version !== target.version + (row.importedChunks ? 1 : 0) ||
        current.controlVersion !== target.controlVersion + (row.importedChunks ? 1 : 0) ||
        current.controlState !== "paused" ||
        (current.leaseExpiresAt && current.leaseExpiresAt > now)
      )
        fail("WORKFLOW_VERSION_CONFLICT");
    }
    if (row.importedChunks === 0) {
      for (const item of manifest.workflows) {
        const target = targets.find((t) => t.workflowId === item.workflowId)!;
        await tx.workflowConfigurationVersion.create({
          data: {
            orgId: actor.orgId,
            workflowId: item.workflowId,
            version: target.version + 1,
            configuration: json(item.configuration),
            createdBy: actor.id
          }
        });
        await tx.workflowAuthorization.updateMany({
          where: { orgId: actor.orgId, workflowId: item.workflowId, revokedAt: null },
          data: { revokedAt: now, revokedBy: actor.id }
        });
        for (const scope of item.authorizations)
          await tx.workflowAuthorization.create({
            data: {
              orgId: actor.orgId,
              workflowId: item.workflowId,
              configurationVersion: target.version + 1,
              controlVersion: target.controlVersion + 1,
              scope: json(scope),
              grantedBy: actor.id
            }
          });
        await tx.enterpriseWorkflow.update({
          where: { id: item.workflowId },
          data: {
            version: { increment: 1 },
            controlVersion: { increment: 1 },
            controlState: "paused"
          }
        });
      }
      await tx.enterpriseIntegration.update({
        where: {
          orgId_enterpriseKey: { orgId: actor.orgId, enterpriseKey: workflow.enterpriseKey }
        },
        data: {
          version: { increment: 1 },
          configuration: json(manifest.integration),
          updatedBy: actor.id
        }
      });
    }
    const page = await tx.workflowMigrationChunk.findUniqueOrThrow({
      where: {
        orgId_migrationId_sequence: {
          orgId: actor.orgId,
          migrationId: row.id,
          sequence: row.importedChunks
        }
      }
    });
    for (const item of workflowMigrationChunkSchema.parse(page.payload)) {
      const imported = [
        ...item.completedActions.map((a) => ({
          intent: a.intent,
          receipt: a.receipt,
          legacyKeyHash: a.legacyKeyHash
        })),
        ...item.unresolved
          .filter((a) => a.code === "unknown_action")
          .map((a) => ({ intent: a.intent!, receipt: a.receipt!, legacyKeyHash: undefined }))
      ];
      for (const record of imported) {
        const keys = deduplicationKeys(workflowActionIdentitySchema.parse(record.intent.identity), {
          runId: `migration_${row.id}`,
          actionId: record.intent.actionId
        });
        const receipt = workflowActionReceiptSchema.parse(record.receipt);
        const existing = await tx.workflowAction.findUnique({
          where: {
            orgId_workflowId_actionId: {
              orgId: actor.orgId,
              workflowId: item.workflowId,
              actionId: record.intent.actionId
            }
          }
        });
        if (existing) {
          if (existing.idempotencyKey !== hash(keys) || hash(existing.receipt) !== hash(receipt))
            fail("WORKFLOW_VERSION_CONFLICT");
          continue;
        }
        await tx.workflowAction.create({
          data: {
            orgId: actor.orgId,
            workflowId: item.workflowId,
            actionId: record.intent.actionId,
            runId: `migration_${row.id}`,
            idempotencyKey: hash(keys),
            identity: json(record.intent.identity),
            artifactHash: record.intent.artifactHash,
            correlationMarker: record.intent.correlationMarker,
            state: receipt.state,
            receipt: json(receipt),
            confirmedAt: receipt.state === "confirmed" ? new Date(receipt.verifiedAt) : null
          }
        });
        await tx.workflowActionDeduplication.createMany({
          data: [
            ...keys,
            ...(record.legacyKeyHash ? [hash(["legacy", record.legacyKeyHash])] : [])
          ].map((key) => ({
            orgId: actor.orgId,
            workflowId: item.workflowId,
            key,
            actionId: record.intent.actionId
          }))
        });
      }
    }
    await tx.workflowMigrationChunk.update({
      where: {
        orgId_migrationId_sequence: {
          orgId: actor.orgId,
          migrationId: row.id,
          sequence: page.sequence
        }
      },
      data: { importedAt: now }
    });
    const complete = row.importedChunks + 1 === row.chunkCount;
    const changed = await tx.workflowMigration.update({
      where: { id: row.id },
      data: {
        importedChunks: { increment: 1 },
        version: { increment: 1 },
        ...(complete ? { stage: "imported" } : {})
      }
    });
    await audit(tx, actor, "migration_import", workflow.id, {
      migrationId: row.id,
      sequence: page.sequence,
      complete
    });
    return {
      ...migrationView(changed),
      complete,
      nextSequence: complete ? null : changed.importedChunks
    };
  }
  if (op.stage === "host_switched" || op.stage === "verified") {
    for (const target of targets) {
      const current = await tx.enterpriseWorkflow.findUniqueOrThrow({
        where: { id: target.workflowId }
      });
      if (!current.assignedInstallationId || current.assignmentEpoch <= target.assignmentEpoch)
        fail("WORKFLOW_INSTALLATION_MISMATCH");
      const installation = await tx.workflowInstallation.findUnique({
        where: {
          orgId_workflowId_installationId: {
            orgId: actor.orgId,
            workflowId: target.workflowId,
            installationId: current.assignedInstallationId
          }
        }
      });
      if (
        !installation?.hostSnapshot ||
        (op.stage === "verified" && installation.firstRunVerification !== "verified")
      )
        fail("WORKFLOW_SOURCE_UNAVAILABLE");
      const installedHost = workflowHostSnapshotSchema.parse(installation.hostSnapshot);
      const oldHost = manifest.workflows.find(
        (w) => w.workflowId === target.workflowId
      )!.hostSnapshot;
      if (
        installedHost.taskId === oldHost.taskId ||
        Date.parse(installedHost.verifiedAt) < row.createdAt.getTime() - 60000
      )
        fail("WORKFLOW_SOURCE_UNAVAILABLE");
    }
  }
  const changed = await tx.workflowMigration.update({
    where: { id: row.id },
    data: { stage: op.stage, version: { increment: 1 } }
  });
  await audit(tx, actor, `migration_${op.stage}`, workflow.id, { migrationId: row.id });
  return migrationView(changed);
}
