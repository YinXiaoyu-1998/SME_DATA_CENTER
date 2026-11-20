import { expect, it } from "vitest";
import { workflowConfigurationSchema } from "@smedc/domain";
import { supportsWorkflowConfiguration } from "./package-compatibility.js";

it("requires newer versions only for runs selecting combo sales", () => {
  const daily = {
    schemaVersion: 1,
    type: "meituan-daily-ingestion",
    storeNames: ["合成门店"],
    orderScope: "settled_only",
    cleanupPolicy: "confirmed_files_only",
    notificationPolicy: "action_required"
  };
  const original = workflowConfigurationSchema.parse({ ...daily, datasets: ["dishes"] });
  const combo = workflowConfigurationSchema.parse({
    ...daily,
    datasets: ["dishes", "combo_sales"]
  });
  const oldInstallation = { launcherVersion: "0.22.1", workflowPackageVersion: "1.0.11" };
  expect(supportsWorkflowConfiguration(original, oldInstallation)).toBe(true);
  expect(supportsWorkflowConfiguration(combo, oldInstallation)).toBe(false);
  expect(
    supportsWorkflowConfiguration(combo, {
      ...oldInstallation,
      launcherVersion: "0.22.2"
    })
  ).toBe(false);
  expect(
    supportsWorkflowConfiguration(combo, {
      launcherVersion: "0.22.2",
      workflowPackageVersion: "1.0.12"
    })
  ).toBe(true);
});
