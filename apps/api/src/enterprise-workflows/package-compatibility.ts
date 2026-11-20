import {
  WORKFLOW_COMBO_SALES_MINIMUM_LAUNCHER_VERSION,
  WORKFLOW_COMBO_SALES_MINIMUM_PACKAGE_VERSION,
  type WorkflowConfiguration
} from "@smedc/domain";
import { launcherVersionAtLeast } from "../request-audit-context.js";

// Package patches share the v1 protocol; new minor/major lines require service review.
// This is independent of the service capability version and never rewrites a run's pin.
export function supportsWorkflowPackageVersion(version: string): boolean {
  return /^1\.0\.(0|[1-9][0-9]*)$/.test(version);
}

export function supportsWorkflowConfiguration(
  configuration: WorkflowConfiguration,
  installation: { launcherVersion: string; workflowPackageVersion: string }
): boolean {
  if (
    configuration.type !== "meituan-daily-ingestion" ||
    !configuration.datasets.includes("combo_sales")
  )
    return true;
  return (
    launcherVersionAtLeast(
      installation.launcherVersion,
      WORKFLOW_COMBO_SALES_MINIMUM_LAUNCHER_VERSION
    ) &&
    launcherVersionAtLeast(
      installation.workflowPackageVersion,
      WORKFLOW_COMBO_SALES_MINIMUM_PACKAGE_VERSION
    )
  );
}
