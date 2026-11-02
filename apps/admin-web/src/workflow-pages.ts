import { escapeHtml, localized, shell } from "./pages.js";
import { workflowCopy } from "./workflow-copy.js";
import { workflowClientSource } from "./workflow-client.js";

export function renderWorkflowPage(options: {
  nonce: string;
  orgId: string;
  enterpriseKey?: string;
  organizationName: string;
  employeeName: string;
  csrfToken: string;
}): string {
  const base = `/admin/permissions/${encodeURIComponent(options.orgId)}`;
  return shell(
    {
      nonce: options.nonce,
      title: { zh: "自动任务 · SMEDC", en: "Automatic tasks · SMEDC" },
      styles:
        ".tabs button[aria-current=page]{background:#22584a;color:#fff}.summary dt{font-weight:600;margin-top:.7rem}.summary dd{margin-left:1rem;overflow-wrap:anywhere}fieldset{border:1px solid #c4d3cb;border-radius:6px;margin:.8rem 0;min-width:0}"
    },
    `<main><h1>${localized(workflowCopy.title!)}</h1><p class="identity">${escapeHtml(options.organizationName)} · ${escapeHtml(options.employeeName)}</p><p>${localized(workflowCopy.intro!)}</p><a href="${escapeHtml(base)}">${localized(workflowCopy.permissionsLink!)}</a><div id="workflow-notice" role="alert" hidden></div><section id="workflows-app" aria-busy="true"><p role="status">${localized(workflowCopy.loading!)}</p></section><form method="post" action="${escapeHtml(base)}/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}"><button type="submit" class="secondary">${localized(workflowCopy.logout!)}</button></form></main><script nonce="${options.nonce}" type="application/json" id="workflow-config">${JSON.stringify({ orgId: options.orgId, enterpriseKey: options.enterpriseKey, csrfToken: options.csrfToken, copy: workflowCopy }).replace(/</g, "\\u003c")}</script>`,
    workflowClientSource
  );
}
