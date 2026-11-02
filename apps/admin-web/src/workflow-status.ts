/** Read-only recorded state: never changes a Codex task or invents readiness. */
export const workflowStatusSource = String.raw`
 async function renderStatus(parent, view) {
  parent.append(heading("status"), pair("statusHelp", "p"));
  if (!view) { parent.append(pair("notConfigured", "p")); return; }
  const current = () => controller.state.views[controller.state.selected]?.workflowId === view.workflowId && parent.isConnected;
  const result = await request("get_workflow_status", { workflowId: view.workflowId, limit: 25 });
  if (!current()) return;
  parent.append(el("p", {}, pair("observedAt"), ": " + new Date(result.observedAt).toLocaleString()));
  if (result.possibleMissedWindow) parent.append(pair("possibleMissed", "p"));
  const designated = result.installations.find(item => item.installationId === result.assignedInstallationId);
  parent.append(el("h3", {}, pair("designated"), ": ", designated?.deviceAlias || pair("notAssigned")));
  if (!result.installations.length) parent.append(pair("not_installed", "p"), pair("installHelp", "p"));
  for (const installation of result.installations) {
   const panel = el("div", { class: "subpanel" }, el("h3", {}, installation.deviceAlias), pair(installation.state, "p"), el("p", {}, pair("firstRun"), ": ", pair(installation.firstRunVerification || "unverified")), heading("preparation", "h3"));
   const checks = Array.isArray(installation.readinessChecks) ? installation.readinessChecks : [];
   if (!checks.length) panel.append(pair("not_checked", "p"));
   for (const check of checks) panel.append(el("div", { class: "subpanel" }, el("strong", {}, pair(check.capability)), el("p", {}, pair(check.status)), check.sampleStatus ? pair(check.sampleStatus, "p") : null, el("p", {}, pair("nextStep"), ": " + check.nextStep), el("small", {}, pair("checkedAt"), ": " + new Date(check.checkedAt).toLocaleString())));
   const host = installation.hostSnapshot;
   if (host) panel.append(heading("schedule", "h3"), summary({ cron: host.cron, host_timezone: host.timezone, model: host.model, reasoningEffort: host.reasoningEffort, state: host.state, verifiedAt: host.verifiedAt }));
   parent.append(panel);
  }
  const pending = el("div", {}, heading("pendingActions", "h3"), pair("pendingHelp", "p")); parent.append(pending);
  const appendActions = async page => {
   if (!page.pendingActions.length) return;
   const details = await request("record_workflow_action", { workflowId: view.workflowId, operation: { kind: "get", actionIds: page.pendingActions.map(a => a.actionId) } });
   if (!current()) return;
   for (const action of page.pendingActions) {
    const detail = details.actions.find(a => a.actionId === action.actionId);
    pending.append(el("div", { class: "subpanel" }, pair(action.state, "p"), el("small", {}, new Date(action.updatedAt).toLocaleString()), detail ? summary(detail.identity) : pair("unavailable", "p")));
   }
  };
  await appendActions(result); if (!result.pendingActions.length) pending.append(pair("empty", "p"));
  let actionCursor = result.nextActionCursor;
  const moreActions = button("more", async () => { const next = await request("get_workflow_status", { workflowId: view.workflowId, actionCursor, limit: 25 }); if (!current()) return; await appendActions(next); actionCursor = next.nextActionCursor; moreActions.hidden = !actionCursor; }); moreActions.hidden = !actionCursor; pending.append(moreActions);
  const runs = el("div", {}, heading("runs", "h3")); parent.append(runs);
  const appendRuns = page => { for (const run of page.runs) runs.append(el("p", {}, pair(run.status), " · ", pair("window"), ": " + String(run.startDate).slice(0,10) + " – " + String(run.endDate).slice(0,10))); };
  appendRuns(result); if (!result.runs.length) runs.append(pair("empty", "p"));
  let cursor = result.nextCursor;
  const moreRuns = button("more", async () => { const next = await request("get_workflow_status", { workflowId: view.workflowId, cursor, limit: 25 }); if (!current()) return; appendRuns(next); cursor = next.nextCursor; moreRuns.hidden = !cursor; }); moreRuns.hidden = !cursor; runs.append(moreRuns);
 }
`;
