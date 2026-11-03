import { renderPermissionsPage } from "./pages.js";

export function renderWorkflowPage(options: {
  nonce: string;
  orgId: string;
  enterpriseKey?: string;
  organizationName: string;
  employeeName: string;
  csrfToken: string;
}): string {
  return renderPermissionsPage({
    ...options,
    workflows: { active: true, enterpriseKey: options.enterpriseKey }
  });
}
