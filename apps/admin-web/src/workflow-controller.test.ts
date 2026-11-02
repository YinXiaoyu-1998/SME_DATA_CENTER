import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { workflowModelSource } from "./workflow-model.js";

it("saves only the exact server preview after explicit confirmation and keeps a conflicting draft", async () => {
  const { workflowControllerSource } = await import("./workflow-controller.js");
  const calls: Array<[string, unknown]> = [];
  let conflict = false;
  const controller = runInNewContext(
    `${workflowModelSource}\n${workflowControllerSource}; createWorkflowController(options)`,
    {
      options: {
        enterpriseKey: "business-a",
        request: async (tool: string, input: unknown) => {
          calls.push([tool, input]);
          if (tool === "list_enterprise_workflows")
            return {
              workflows: [
                {
                  workflowType: "weekly-business-report",
                  version: 3,
                  controlVersion: 2,
                  integration: {
                    version: 4,
                    configuration: { storeMappings: [], exclusions: [], sourceAccounts: [] }
                  },
                  configuration: { type: "weekly-business-report", storeNames: ["A"], groups: [] }
                }
              ],
              nextCursor: null
            };
          if (tool === "prepare_enterprise_workflow_change")
            return {
              ...(input as object),
              previewId: "preview",
              confirmationDigest: "a".repeat(64)
            };
          if (conflict) throw { code: "WORKFLOW_VERSION_CONFLICT" };
          return {
            workflowType: "weekly-business-report",
            version: 4,
            controlVersion: 2,
            integration: { version: 4, configuration: {} },
            configuration: { type: "weekly-business-report", storeNames: ["A", "B"] }
          };
        }
      }
    }
  );
  await controller.load();
  controller.select("weekly-business-report");
  controller.state.drafts["weekly-business-report"].storeNames.push("B");
  const change = {
    kind: "configuration",
    configuration: controller.state.drafts["weekly-business-report"]
  };
  await controller.commit(change, async () => false);
  expect(calls.map(([tool]) => tool)).not.toContain("save_enterprise_workflow");
  await controller.commit(change, async () => true);
  expect(calls.at(-1)).toEqual([
    "save_enterprise_workflow",
    {
      enterpriseKey: "business-a",
      workflowType: "weekly-business-report",
      expectedVersion: 3,
      expectedIntegrationVersion: 4,
      expectedControlVersion: 2,
      previewId: "preview",
      confirmationDigest: "a".repeat(64)
    }
  ]);
  conflict = true;
  controller.state.drafts["weekly-business-report"].storeNames.push("C");
  await expect(
    controller.commit(
      { kind: "control", state: "paused", reason: "administrator request" },
      async () => true
    )
  ).rejects.toMatchObject({ code: "WORKFLOW_VERSION_CONFLICT" });
  expect(controller.state.conflicted).toBe(true);
  expect(controller.state.pendingChange).toEqual({
    kind: "control",
    state: "paused",
    reason: "administrator request"
  });
  expect(controller.state.drafts["weekly-business-report"].storeNames).toEqual(["A", "B", "C"]);
});
