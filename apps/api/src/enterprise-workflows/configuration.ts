import { z } from "zod";
import {
  ENTERPRISE_WORKFLOW_CAPABILITY,
  workflowLivePolicy,
  intersectWorkflowLivePolicy,
  workflowLivePolicySchema,
  workflowRunSnapshotSchema,
  enterpriseIntegrationSchema,
  workflowConfigurationSchema,
  workflowChangeSchema,
  workflowAuthorizationScopeSchema,
  type WorkflowConfiguration,
  type EnterpriseIntegrationConfiguration
} from "@smedc/domain";
import type { WorkflowOperationInputs } from "@smedc/mcp-contract";
import {
  audit,
  dbType,
  fail,
  hash,
  id,
  json,
  publicType,
  type Actor,
  type Tx,
  type Workflow
} from "./repository.js";
export async function ensureWorkflow(
  tx: Tx,
  actor: Actor,
  input: WorkflowOperationInputs["get_enterprise_workflow"]
) {
  const enterprise = await tx.businessEnterpriseIdentity.findUnique({
    where: { orgId_enterpriseKey: { orgId: actor.orgId, enterpriseKey: input.enterpriseKey } }
  });
  if (!enterprise || enterprise.enterpriseKey !== input.enterpriseKey)
    fail("WORKFLOW_CONFIGURATION_REQUIRED");
  await tx.enterpriseIntegration.upsert({
    where: { orgId_enterpriseKey: { orgId: actor.orgId, enterpriseKey: input.enterpriseKey } },
    create: {
      orgId: actor.orgId,
      enterpriseKey: input.enterpriseKey,
      updatedBy: actor.id,
      configuration: {
        schemaVersion: 1,
        timezone: "Asia/Shanghai",
        sourceAccounts: [],
        storeMappings: [],
        exclusions: []
      }
    },
    update: {}
  });
  return tx.enterpriseWorkflow.upsert({
    where: {
      orgId_enterpriseKey_type: {
        orgId: actor.orgId,
        enterpriseKey: input.enterpriseKey,
        type: dbType(input.workflowType)
      }
    },
    create: {
      orgId: actor.orgId,
      enterpriseKey: input.enterpriseKey,
      type: dbType(input.workflowType)
    },
    update: {}
  });
}
export async function configuration(tx: Tx, workflow: Workflow, version = workflow.version) {
  const row = await tx.workflowConfigurationVersion.findUnique({
    where: { orgId_workflowId_version: { orgId: workflow.orgId, workflowId: workflow.id, version } }
  });
  return row ? workflowConfigurationSchema.parse(row.configuration) : null;
}
export async function integration(tx: Tx, workflow: Workflow) {
  const row = await tx.enterpriseIntegration.findUniqueOrThrow({
    where: { orgId_enterpriseKey: { orgId: workflow.orgId, enterpriseKey: workflow.enterpriseKey } }
  });
  return { ...row, configuration: enterpriseIntegrationSchema.parse(row.configuration) };
}
export async function view(tx: Tx, workflow: Workflow) {
  return {
    capability: ENTERPRISE_WORKFLOW_CAPABILITY,
    workflowId: workflow.id,
    enterpriseKey: workflow.enterpriseKey,
    workflowType: publicType(workflow.type),
    version: workflow.version,
    controlVersion: workflow.controlVersion,
    controlState: workflow.controlState,
    assignmentEpoch: workflow.assignmentEpoch,
    assignedInstallationId: workflow.assignedInstallationId,
    lease: { runId: workflow.leaseRunId, expiresAt: workflow.leaseExpiresAt },
    configuration: await configuration(tx, workflow),
    integration: await integration(tx, workflow),
    authorizations: (
      await tx.workflowAuthorization.findMany({
        where: { orgId: workflow.orgId, workflowId: workflow.id, revokedAt: null }
      })
    ).map((a) => ({
      authorizationId: a.id,
      scope: workflowAuthorizationScopeSchema.parse(a.scope),
      configurationVersion: a.configurationVersion,
      controlVersion: a.controlVersion,
      grantedBy: a.grantedBy,
      grantedAt: a.grantedAt,
      revokedAt: a.revokedAt
    }))
  };
}
export async function validateStores(tx: Tx, workflow: Workflow, stores: string[]) {
  const rows = await tx.businessStore.findMany({
    where: {
      orgId: workflow.orgId,
      enterpriseKey: workflow.enterpriseKey,
      name: { in: stores },
      retired: false
    }
  });
  if (stores.some((s) => !rows.some((r) => r.name === s))) fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
}
export async function validateConfiguration(
  tx: Tx,
  workflow: Workflow,
  config: WorkflowConfiguration,
  source?: EnterpriseIntegrationConfiguration
) {
  if (config.type !== publicType(workflow.type)) fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
  await validateStores(tx, workflow, config.storeNames);
  if (source && config.type !== "weekly-business-report") {
    const product = config.type === "meituan-daily-ingestion" ? "meituan_erp" : "meituan_reviews";
    const channels = config.type === "meituan-review-operations" ? config.channels : ["erp"];
    if (
      config.storeNames.some((store) =>
        channels.some(
          (channel) =>
            !source.storeMappings.some(
              (m) =>
                m.storeName === store &&
                m.source.product === product &&
                m.source.channel === channel
            )
        )
      )
    )
      fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
  }
}
const impactSchema = z
  .object({
    affectedWorkflows: z
      .array(z.object({ workflowType: z.string(), storeNames: z.array(z.string()) }).strict())
      .max(3)
  })
  .strict();
const previewEnvelopeSchema = z
  .object({
    change: workflowChangeSchema,
    dependencies: z
      .array(
        z
          .object({ workflowId: z.string(), version: z.number(), controlVersion: z.number() })
          .strict()
      )
      .max(3),
    impact: impactSchema
  })
  .strict();
async function integrationImpact(
  tx: Tx,
  workflow: Workflow,
  before: EnterpriseIntegrationConfiguration,
  after: EnterpriseIntegrationConfiguration
) {
  const dependents = await tx.enterpriseWorkflow.findMany({
    where: { orgId: workflow.orgId, enterpriseKey: workflow.enterpriseKey },
    orderBy: { type: "asc" }
  });
  const dependencies = dependents.map((w) => ({
    workflowId: w.id,
    version: w.version,
    controlVersion: w.controlVersion
  }));
  const affectedWorkflows = [];
  for (const dependent of dependents) {
    const config = await configuration(tx, dependent);
    if (!config) continue;
    const oldPolicy = workflowLivePolicy(config, before);
    const nextPolicy = intersectWorkflowLivePolicy(oldPolicy, workflowLivePolicy(config, after));
    const storeNames = [
      ...new Set(
        oldPolicy.sources
          .filter(
            (s) =>
              !nextPolicy.sources.some(
                (t) => t.binding === s.binding && t.storeName === s.storeName
              )
          )
          .map((s) => s.storeName)
      )
    ].sort();
    if (storeNames.length)
      affectedWorkflows.push({ workflowType: publicType(dependent.type), storeNames });
  }
  return { dependencies, impact: { affectedWorkflows } };
}
// Persist only narrowing limits separately; business snapshots and evidence remain untouched.
async function restrictRuns(
  tx: Tx,
  workflow: Workflow,
  before: WorkflowConfiguration,
  after: WorkflowConfiguration,
  oldSource: EnterpriseIntegrationConfiguration,
  newSource: EnterpriseIntegrationConfiguration
) {
  const oldPolicy = workflowLivePolicy(before, oldSource);
  const nextPolicy = workflowLivePolicy(after, newSource);
  if (hash(oldPolicy) === hash(intersectWorkflowLivePolicy(oldPolicy, nextPolicy))) return;
  await tx.enterpriseWorkflow.update({
    where: { id: workflow.id },
    data: { controlVersion: { increment: 1 } }
  });
  const runs = await tx.workflowRun.findMany({
    where: { orgId: workflow.orgId, workflowId: workflow.id, finishedAt: null }
  });
  for (const run of runs) {
    const snapshot = workflowRunSnapshotSchema.parse(run.snapshot);
    const original = workflowLivePolicy(snapshot.configuration, snapshot.integration);
    const previous =
      run.restrictivePolicy === null
        ? original
        : workflowLivePolicySchema.parse(run.restrictivePolicy);
    await tx.workflowRun.update({
      where: { id: run.id },
      data: { restrictivePolicy: json(intersectWorkflowLivePolicy(previous, nextPolicy)) }
    });
  }
}
export async function prepareChange(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  input: WorkflowOperationInputs["prepare_enterprise_workflow_change"],
  now: Date
) {
  const shared = await integration(tx, workflow);
  checkVersions(workflow, shared.version, input);
  if (input.change.kind === "configuration")
    await validateConfiguration(tx, workflow, input.change.configuration);
  if (input.change.kind === "integration")
    await validateStores(
      tx,
      workflow,
      input.change.configuration.storeMappings.map((m) => m.storeName)
    );
  const previewId = id();
  const context =
    input.change.kind === "integration"
      ? await integrationImpact(tx, workflow, shared.configuration, input.change.configuration)
      : null;
  const preparedChange = context ? { change: input.change, ...context } : input.change;
  const confirmationDigest = hash({ previewId, actor, input, preparedChange });
  const expiresAt = new Date(now.getTime() + 15 * 60000);
  await tx.workflowChangePreview.create({
    data: {
      id: previewId,
      orgId: actor.orgId,
      enterpriseKey: workflow.enterpriseKey,
      workflowType: workflow.type,
      expectedVersion: workflow.version,
      expectedIntegrationVersion: shared.version,
      expectedControlVersion: workflow.controlVersion,
      change: json(preparedChange),
      confirmationDigest,
      preparedBy: actor.id,
      expiresAt
    }
  });
  await audit(tx, actor, "prepare_change", workflow.id, {
    previewId,
    kind: input.change.kind,
    ...(context ? { impact: context.impact } : {})
  });
  return {
    ...input,
    previewId,
    confirmationDigest,
    expiresAt: expiresAt.toISOString(),
    ...(context ? { impact: context.impact } : {})
  };
}
export function checkVersions(
  workflow: Workflow,
  integrationVersion: number,
  input: {
    expectedVersion: number;
    expectedIntegrationVersion: number;
    expectedControlVersion: number;
  }
) {
  if (
    workflow.version !== input.expectedVersion ||
    integrationVersion !== input.expectedIntegrationVersion ||
    workflow.controlVersion !== input.expectedControlVersion
  )
    fail("WORKFLOW_VERSION_CONFLICT");
}
export async function saveChange(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  input: WorkflowOperationInputs["save_enterprise_workflow"],
  now: Date
) {
  const shared = await integration(tx, workflow);
  checkVersions(workflow, shared.version, input);
  const preview = await tx.workflowChangePreview.findFirst({
    where: {
      id: input.previewId,
      orgId: actor.orgId,
      enterpriseKey: workflow.enterpriseKey,
      workflowType: workflow.type,
      preparedBy: actor.id,
      confirmationDigest: input.confirmationDigest,
      consumedAt: null,
      expiresAt: { gt: now },
      expectedVersion: input.expectedVersion,
      expectedIntegrationVersion: input.expectedIntegrationVersion,
      expectedControlVersion: input.expectedControlVersion
    }
  });
  if (!preview) fail("WORKFLOW_VERSION_CONFLICT");
  const envelope = previewEnvelopeSchema.safeParse(preview.change);
  const parsedChange = workflowChangeSchema.safeParse(
    envelope.success ? envelope.data.change : preview.change
  );
  if (!parsedChange.success) fail("WORKFLOW_VERSION_CONFLICT");
  const change = parsedChange.data;
  let impact: z.infer<typeof impactSchema> | undefined;
  if (change.kind === "integration") {
    if (!envelope.success) fail("WORKFLOW_VERSION_CONFLICT");
    const current = await integrationImpact(
      tx,
      workflow,
      shared.configuration,
      change.configuration
    );
    if (
      hash(current) !==
      hash({ dependencies: envelope.data.dependencies, impact: envelope.data.impact })
    )
      fail("WORKFLOW_VERSION_CONFLICT");
    impact = current.impact;
  }
  if (change.kind === "configuration") {
    await validateConfiguration(tx, workflow, change.configuration);
    const previous = await configuration(tx, workflow);
    if (previous)
      await restrictRuns(
        tx,
        workflow,
        previous,
        change.configuration,
        shared.configuration,
        shared.configuration
      );
    await tx.workflowConfigurationVersion.create({
      data: {
        orgId: actor.orgId,
        workflowId: workflow.id,
        version: workflow.version + 1,
        configuration: json(change.configuration),
        createdBy: actor.id
      }
    });
    await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: { version: { increment: 1 } }
    });
  } else if (change.kind === "integration") {
    await validateStores(
      tx,
      workflow,
      change.configuration.storeMappings.map((m) => m.storeName)
    );
    const dependents = await tx.enterpriseWorkflow.findMany({
      where: { orgId: actor.orgId, enterpriseKey: workflow.enterpriseKey },
      orderBy: { id: "asc" }
    });
    for (const dependent of dependents) {
      const config = await configuration(tx, dependent);
      if (config)
        await restrictRuns(
          tx,
          dependent,
          config,
          config,
          shared.configuration,
          change.configuration
        );
    }
    const updated = await tx.enterpriseIntegration.updateMany({
      where: { orgId: actor.orgId, enterpriseKey: workflow.enterpriseKey, version: shared.version },
      data: {
        configuration: json(change.configuration),
        version: { increment: 1 },
        updatedBy: actor.id
      }
    });
    if (updated.count !== 1) fail("WORKFLOW_VERSION_CONFLICT");
  } else if (change.kind === "authorization") {
    const config = await configuration(tx, workflow);
    if (
      !config ||
      change.grant.some((g) => g.storeNames.some((s) => !config.storeNames.includes(s)))
    )
      fail("WORKFLOW_CONFIGURATION_REQUIRED");
    if (change.revokeAuthorizationIds.length) {
      const revoked = await tx.workflowAuthorization.updateMany({
        where: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          id: { in: change.revokeAuthorizationIds },
          revokedAt: null
        },
        data: { revokedAt: now, revokedBy: actor.id }
      });
      if (revoked.count !== change.revokeAuthorizationIds.length) fail("WORKFLOW_VERSION_CONFLICT");
    }
    if (
      (await tx.workflowAuthorization.count({
        where: { orgId: actor.orgId, workflowId: workflow.id, revokedAt: null }
      })) +
        change.grant.length >
      20
    )
      fail("WORKFLOW_PERMISSION_DENIED");
    for (const scope of change.grant)
      await tx.workflowAuthorization.create({
        data: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          scope: json(scope),
          configurationVersion: workflow.version,
          controlVersion: workflow.controlVersion + 1,
          grantedBy: actor.id
        }
      });
    await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: { controlVersion: { increment: 1 } }
    });
  } else {
    if (change.state === "active") {
      const config = await configuration(tx, workflow);
      if (!config) fail("WORKFLOW_CONFIGURATION_REQUIRED");
      await validateConfiguration(tx, workflow, config, shared.configuration);
    }
    await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: { controlState: change.state, controlVersion: { increment: 1 } }
    });
  }
  await tx.workflowChangePreview.update({ where: { id: preview.id }, data: { consumedAt: now } });
  await audit(tx, actor, "save_change", workflow.id, {
    previewId: preview.id,
    kind: change.kind,
    ...(impact ? { impact } : {})
  });
  return view(tx, await tx.enterpriseWorkflow.findUniqueOrThrow({ where: { id: workflow.id } }));
}
