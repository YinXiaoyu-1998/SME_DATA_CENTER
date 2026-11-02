/** Shared with the inline client: drafts never leave page memory. */
export const workflowModelSource = String.raw`
const workflowModel = {
 clone(value) { return JSON.parse(JSON.stringify(value)); },
 selectVisible(selected, visible, checked) { return [...new Set([...selected.filter(name => !visible.includes(name)), ...checked])]; },
 draft(type, saved) {
  if (saved) return this.clone(saved);
  const common = { schemaVersion: 1, type, storeNames: [], notificationPolicy: "action_required" };
  if (type === "meituan-daily-ingestion") return { ...common, datasets: [], orderScope: "settled_only", cleanupPolicy: "confirmed_files_only" };
  if (type === "meituan-review-operations") return { ...common, executionPolicy: { id: "verified-review-operations", version: 1 }, ignoredReviewIdentities: [], channels: [], publication: { enabled: false, storeNames: [] }, brandFacts: "", tone: "", draftNotification: { enabled: false, recipients: [] }, cleanupPolicy: "complete_run_only" };
  return { ...common, groups: [], delivery: { enabled: false, recipients: [] }, cleanupPolicy: "retain_final_report" };
 },
 expected(view) { return { expectedVersion: view?.version ?? 0, expectedIntegrationVersion: view?.integration.version ?? 0, expectedControlVersion: view?.controlVersion ?? 0 }; },
 validate(config) {
  if (!config.storeNames.length) return "storesRequired";
  if (config.type === "meituan-daily-ingestion" && !config.datasets.length) return "datasetsRequired";
  if (config.type === "meituan-review-operations") {
   if (!config.channels.length) return "channelsRequired";
   if ((config.publication.enabled && !config.publication.storeNames.length) || config.publication.storeNames.some(s => !config.storeNames.includes(s))) return "publicationInvalid";
  }
  if (config.type === "weekly-business-report") {
   const names = config.groups.map(g => g.name), stores = config.groups.flatMap(g => g.storeNames);
   if (names.some(n => !n.trim()) || new Set(names).size !== names.length || config.groups.some(g => !g.storeNames.length) || stores.some(s => !config.storeNames.includes(s)) || new Set(stores).size !== stores.length) return "groupsInvalid";
  }
  const mail = config.draftNotification || config.delivery;
  if (mail && (mail.recipients.length > 20 || new Set(mail.recipients.map(s => s.toLowerCase())).size !== mail.recipients.length || mail.recipients.some(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) || (mail.allowedSender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail.allowedSender)) || (mail.enabled && (!mail.allowedSender || !mail.recipients.length)))) return "mailInvalid";
  return null;
 }
};`;
