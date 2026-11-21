import { describe, expect, it } from "vitest";
import {
  enterpriseIntegrationSchema,
  workflowActionIdentitySchema,
  workflowConfigurationSchema,
  workflowLivePolicy,
  type AuthorizationSnapshot,
  type WorkflowRunSnapshot
} from "@smedc/domain";
import { authorizeAction } from "./actions.js";
import type { Tx, Workflow } from "./repository.js";

const actor = { id: "synthetic-admin", orgId: "synthetic-org" };
const workflow = { id: "synthetic-workflow" } as Workflow;
const auth = { mode: "enabled" } as AuthorizationSnapshot;
const window = { startDate: "2026-11-20", endDate: "2026-11-20" };
const integration = enterpriseIntegrationSchema.parse({
  schemaVersion: 1,
  timezone: "Asia/Shanghai",
  sourceAccounts: [
    {
      product: "meituan_erp",
      accountRef: "erp",
      displayName: "Synthetic",
      sourceEnterpriseName: "Synthetic"
    }
  ],
  storeMappings: ["Store A", "Store B"].map((storeName) => ({
    storeName,
    source: {
      product: "meituan_erp",
      channel: "erp",
      accountRef: "erp",
      sourceStoreName: storeName
    }
  })),
  exclusions: []
});

function checkUpload(
  datasets: string[],
  dataset: "dishes" | "combo_sales",
  storeName = "Store A",
  selected = ["dishes", "combo_sales"]
) {
  const configuration = workflowConfigurationSchema.parse({
    schemaVersion: 1,
    type: "meituan-daily-ingestion",
    orderScope: "settled_only",
    cleanupPolicy: "confirmed_files_only",
    notificationPolicy: "action_required",
    datasets: selected,
    storeNames: ["Store A", "Store B"]
  });
  const snapshot: WorkflowRunSnapshot = {
    workflowType: "meituan-daily-ingestion",
    configurationVersion: 1,
    integrationVersion: 1,
    workflowPackageVersion: "1.0.14",
    window,
    configuration,
    integration
  };
  // Exercise the production authorization path with the active standing scopes a database read would return.
  const tx = {
    workflowAuthorization: {
      findMany: async () => [{ scope: { kind: "upload", storeNames: ["Store A"], datasets } }]
    }
  } as unknown as Tx;
  const identity = workflowActionIdentitySchema.parse({
    kind: "upload",
    dataset,
    storeNames: [storeName],
    window,
    sourceHash: "a".repeat(64),
    metadataHash: "b".repeat(64)
  });
  return authorizeAction(
    tx,
    actor,
    auth,
    workflow,
    snapshot,
    { actionId: "synthetic-upload", identity },
    workflowLivePolicy(configuration, integration)
  );
}

describe("daily dish sales authorization", () => {
  it("uses an existing dish sales grant for either selected report at the same store", async () => {
    await expect(checkUpload(["dishes"], "dishes")).resolves.toBeUndefined();
    await expect(checkUpload(["dishes"], "combo_sales")).resolves.toBeUndefined();
  });

  it("does not broaden a legacy combo-only grant", async () => {
    await expect(checkUpload(["combo_sales"], "combo_sales")).resolves.toBeUndefined();
    await expect(checkUpload(["combo_sales"], "dishes")).rejects.toThrow(
      "WORKFLOW_PERMISSION_DENIED"
    );
  });

  it("requires both the selected report and matching authorized store", async () => {
    await expect(checkUpload(["dishes"], "combo_sales", "Store B")).rejects.toThrow(
      "WORKFLOW_PERMISSION_DENIED"
    );
    await expect(checkUpload(["dishes"], "combo_sales", "Store A", ["dishes"])).rejects.toThrow(
      "WORKFLOW_PERMISSION_DENIED"
    );
    await expect(checkUpload(["business"], "combo_sales")).rejects.toThrow(
      "WORKFLOW_PERMISSION_DENIED"
    );
  });
});
