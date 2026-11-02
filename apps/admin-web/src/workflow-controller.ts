/** Public browser actions, shared by the page and its regression tests. */
export const workflowControllerSource = String.raw`
function createWorkflowController(options) {
 const state = { views: {}, drafts: {}, integration: null, selected: "meituan-daily-ingestion", conflicted: false, busy: false, pendingChange: null, authorizationDrafts: {}, revocations: {}, controlReasons: {} };
 function accept(view) {
  state.views[view.workflowType] = view;
  state.drafts[view.workflowType] = workflowModel.draft(view.workflowType, view.configuration);
  state.integration = workflowModel.clone(view.integration.configuration);
 }
 return {
  state,
  async load() {
   const views = {}; let cursor;
   do {
    const result = await options.request("list_enterprise_workflows", { enterpriseKey: options.enterpriseKey, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const view of result.workflows) views[view.workflowType] = view;
    cursor = result.nextCursor;
   } while (cursor);
   state.views = views; state.drafts = {}; state.authorizationDrafts = {}; state.revocations = {}; state.controlReasons = {};
   for (const view of Object.values(views)) accept(view);
   state.integration ||= { schemaVersion: 1, timezone: "Asia/Shanghai", sourceAccounts: [], storeMappings: [], exclusions: [] };
   state.conflicted = false;
  },
  select(type) { state.selected = type; state.drafts[type] ||= workflowModel.draft(type, state.views[type]?.configuration); },
  async commit(change, confirm) {
   if (state.busy || state.conflicted) throw { code: "WORKFLOW_VERSION_CONFLICT" };
   state.busy = true;
   state.pendingChange = workflowModel.clone(change);
   const selected = state.selected;
   const view = state.views[selected];
   const shared = Object.values(state.views).find(v => v.integration)?.integration;
   const binding = { enterpriseKey: options.enterpriseKey, workflowType: selected, ...workflowModel.expected(view) };
   if (!view && shared) binding.expectedIntegrationVersion = shared.version;
   try {
    const preview = await options.request("prepare_enterprise_workflow_change", { ...binding, change: workflowModel.clone(change) });
    if (!await confirm(preview)) return false;
    const saved = await options.request("save_enterprise_workflow", { ...binding, previewId: preview.previewId, confirmationDigest: preview.confirmationDigest });
    state.views[saved.workflowType] = saved;
    if (change.kind === "configuration") state.drafts[saved.workflowType] = workflowModel.draft(saved.workflowType, saved.configuration);
    if (change.kind === "integration") {
     state.integration = workflowModel.clone(saved.integration.configuration);
     for (const current of Object.values(state.views)) current.integration = workflowModel.clone(saved.integration);
    }
    if (change.kind === "authorization") { delete state.authorizationDrafts[selected]; delete state.revocations[selected]; }
    if (change.kind === "control") delete state.controlReasons[selected];
    state.pendingChange = null;
    return true;
   } catch (error) {
    if (error.code === "WORKFLOW_VERSION_CONFLICT") state.conflicted = true;
    throw error;
   } finally { state.busy = false; }
  }
 };
}`;
