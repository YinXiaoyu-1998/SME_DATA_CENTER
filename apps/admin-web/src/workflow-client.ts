import { workflowModelSource } from "./workflow-model.js";
import { workflowControllerSource } from "./workflow-controller.js";
import { workflowEditorsSource } from "./workflow-editors.js";
import { workflowStatusSource } from "./workflow-status.js";

/** Same-origin, dependency-free browser source. All incoming strings become text nodes. */
export const workflowClientSource = String.raw`
(() => {
 "use strict";
 const config = JSON.parse(document.getElementById("workflow-config").textContent);
 const root = document.getElementById("workflows-app"), banner = document.getElementById("workflow-notice");
 const base = "/admin/permissions/" + encodeURIComponent(config.orgId);
 const types = ["meituan-daily-ingestion", "meituan-review-operations", "weekly-business-report"];
 let frozen = false, sequence = 0, stores = [], enterprises = [], controller, dirty = false;
 const locale = () => document.documentElement.lang === "en" ? "en" : "zh";
 const text = key => (config.copy[key] || config.copy.preserved)[locale()];
 function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
   if (value === undefined || value === null || value === false) continue;
   if (["checked", "disabled", "hidden", "multiple"].includes(key)) node[key] = Boolean(value);
   else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child !== undefined && child !== null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
 }
 function pair(key, tag = "span") {
  const copy = typeof key === "string" ? config.copy[key] || config.copy.preserved : key;
  return el(tag, {}, el("span", { "data-locale": "zh-CN", hidden: locale() !== "zh" }, copy.zh), el("span", { "data-locale": "en", hidden: locale() !== "en" }, copy.en));
 }
 const heading = (key, tag = "h2") => pair(key, tag);
 function button(key, action, write = false, style = "secondary") {
  const node = el("button", { type: "button", class: style, "data-write": write ? "true" : undefined }, pair(key));
  node.addEventListener("click", () => Promise.resolve().then(action).catch(showError)); return node;
 }
 function updateButtons() {
  root.querySelectorAll("input, select, textarea").forEach(node => { node.disabled = frozen || controller?.state.busy; });
  root.querySelectorAll("nav.tabs button").forEach(node => { node.disabled = Boolean(controller?.state.busy); });
  root.querySelectorAll('[data-write="true"]').forEach(node => { node.disabled = frozen || controller?.state.conflicted || controller?.state.busy; }); }
 function notice(key, error = false) { banner.replaceChildren(pair(key)); banner.className = error ? "notice error" : "notice"; banner.hidden = false; }
 function showError(error) {
  const mapping = { WORKFLOW_VERSION_CONFLICT: "conflict", BROWSER_SIGN_IN_REQUIRED: "expired", BROWSER_ACCESS_DENIED: "expired", WORKFLOW_ADMIN_REQUIRED: "expired", AUTHORIZATION_ADMIN_REQUIRED: "expired", WORKFLOW_PERMISSION_DENIED: "permission_denied", BROWSER_SECURITY_CHECK_FAILED: "security", WORKFLOW_SOURCE_MAPPING_CONFLICT: "sourceConflict", WORKFLOW_CONFIGURATION_REQUIRED: "configurationRequired", WORKFLOW_VERSION_INCOMPATIBLE: "versionIncompatible", WORKFLOW_BUSY: "busy", WORKFLOW_SOURCE_UNAVAILABLE: "unavailable", INVALID_WORKFLOW_INPUT: "invalid" };
  notice(error.uiKey || mapping[error.code] || "unexpected", true);
  if (error.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(error.requestId)) banner.append(el("p", {}, pair("requestReference"), ": " + error.requestId));
  if (controller?.state.conflicted) banner.append(button("compare", compareLatest));
  updateButtons();
 }
 async function http(path, body) {
  if (frozen) throw { code: "BROWSER_SIGN_IN_REQUIRED" };
  const response = await fetch(base + "/api" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": config.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 || (response.status === 403 && ["BROWSER_ACCESS_DENIED", "BROWSER_SECURITY_CHECK_FAILED", "WORKFLOW_ADMIN_REQUIRED", "AUTHORIZATION_ADMIN_REQUIRED"].includes(result.error?.code))) frozen = true; updateButtons(); throw result.error || {}; }
  return result;
 }
 const request = (tool, input) => http("/workflows/" + tool, input);
 function field(key, control) { const id = "workflow-field-" + (++sequence); control.id = id; return el("div", { "data-field": key }, el("label", { for: id }, pair(key)), control); }
 function input(value, changed, max = 255, multiline = false) {
  const node = el(multiline ? "textarea" : "input", multiline ? { rows: 4, maxlength: max } : { type: "text", maxlength: max });
  node.value = value ?? ""; node.addEventListener("input", () => { changed(node.value); dirty = true; }); return node;
 }
 function select(choices, value, changed) {
  const node = el("select");
  for (const choice of choices) { const copy = choice.label || config.copy[choice.value] || { zh: choice.value, en: choice.value }; node.append(el("option", { value: choice.value, "data-option-zh": copy.zh, "data-option-en": copy.en }, copy[locale()])); }
  node.value = value ?? ""; node.addEventListener("change", () => { changed(node.value); dirty = true; }); return node;
 }
 function check(key, value, changed) { const node = el("input", { type: "checkbox", checked: value }); node.addEventListener("change", () => { changed(node.checked); dirty = true; }); return el("label", { class: "check" }, node, pair(key)); }
 function checklist(key, choices, selected, changed) {
  const box = el("fieldset", {}, el("legend", {}, pair(key)));
  const visible = choices.map(c => typeof c === "string" ? c : c.value), controls = [];
  for (const choice of choices) {
   const value = typeof choice === "string" ? choice : choice.value;
   const label = typeof choice === "string" ? config.copy[choice] || { zh: choice, en: choice } : choice.label;
   const node = el("input", { type: "checkbox", checked: selected.includes(value), value }); controls.push(node);
   node.addEventListener("change", () => { changed(workflowModel.selectVisible(selected, visible, controls.filter(c => c.checked).map(c => c.value))); dirty = true; });
   box.append(el("label", { class: "check" }, node, pair(label)));
  }
  return box;
 }
 function storeChoices(selected = []) {
  const values = new Set(stores.filter(s => !s.retired || selected.includes(s.name)).map(s => s.name));
  for (const name of selected) values.add(name);
  return [...values].map(value => ({ value, label: { zh: value, en: value } }));
 }
 function summary(value) {
  const skip = new Set(["schemaVersion", "type", "executionPolicy", "cleanupPolicy", "notificationPolicy", "authorizationId", "grantedBy", "configurationVersion", "controlVersion", "sourceHash", "metadataHash", "manifestHash", "artifactHash", "identityHash", "correlationMarker"]);
  const list = el("dl", { class: "summary" });
  const add = (key, item) => {
   if (skip.has(key)) return;
   list.append(el("dt", {}, pair(key)));
   const content = el("dd");
   if (Array.isArray(item)) { if (!item.length) content.append(pair("empty")); else for (const child of item) content.append(typeof child === "object" ? summary(child) : el("div", {}, config.copy[child] ? pair(child) : String(child))); }
   else if (item && typeof item === "object") content.append(summary(item));
   else if (typeof item === "boolean") content.append(pair(item ? "yes" : "no"));
   else content.append(config.copy[item] ? pair(item) : String(item ?? ""));
   list.append(content);
  };
  for (const [key, item] of Object.entries(value || {})) add(key, item);
  return list;
 }
 async function dialog(content, action = "confirm", cancel = "cancel") {
  const node = el("dialog", { "aria-labelledby": "workflow-dialog-title" });
  const title = heading("preview"); title.id = "workflow-dialog-title";
  return new Promise(resolve => {
   const close = result => { node.close(); node.remove(); resolve(result); };
   const no = button(cancel, () => close(false));
   node.append(title, content, el("div", { class: "actions" }, no, button(action, () => close(true))));
   node.addEventListener("cancel", event => { event.preventDefault(); close(false); });
   document.body.append(node); node.showModal(); no.focus();
  });
 }
 async function commit(change) {
  const view = controller.state.views[controller.state.selected];
  const before = change.kind === "configuration" ? view?.configuration : change.kind === "integration" ? (view?.integration || Object.values(controller.state.views).find(current => current.integration)?.integration)?.configuration : change.kind === "authorization" ? { authorizations: view?.authorizations || [] } : { state: view?.controlState || "paused" };
  const pending = controller.commit(change, preview => dialog(el("div", {}, pair("confirmHelp", "p"), heading("before", "h3"), summary(before), heading("after", "h3"), summary(preview.change.kind === "authorization" ? { grant: preview.change.grant, revokedScopes: (view?.authorizations || []).filter(a => preview.change.revokeAuthorizationIds.includes(a.authorizationId)).map(a => a.scope) } : preview.change.configuration || preview.change), el("p", {}, pair("expires"), ": " + new Date(preview.expiresAt).toLocaleString()))));
  updateButtons();
  try { if (await pending) { notice("saved"); render(); } } finally { updateButtons(); }
 }
 function humanChange(change, view) {
  if (!change) return {};
  return change.kind === "authorization" ? { grant: change.grant, revokedScopes: (view?.authorizations || []).filter(a => change.revokeAuthorizationIds.includes(a.authorizationId)).map(a => a.scope) } : change.configuration || change;
 }
 async function compareLatest() {
  const latest = createWorkflowController({ request, enterpriseKey: config.enterpriseKey });
  await latest.load(); latest.select(controller.state.selected);
  const content = el("div", {}, pair("conflict", "p"), heading("latest", "h3"), summary(latest.state.views[latest.state.selected]?.configuration), summary(latest.state.integration), summary({ authorizations: latest.state.views[latest.state.selected]?.authorizations || [], state: latest.state.views[latest.state.selected]?.controlState || "paused" }), heading("draft", "h3"), summary(controller.state.drafts[controller.state.selected]), summary(controller.state.integration), summary(humanChange(controller.state.pendingChange, controller.state.views[controller.state.selected])));
  if (await dialog(content, "discard", "keep")) { controller = latest; dirty = false; render(); }
 }
 async function refresh() { if (dirty || controller.state.conflicted) return compareLatest(); await controller.load(); controller.select(controller.state.selected); render(); }
 ${workflowModelSource}
 ${workflowControllerSource}
 ${workflowEditorsSource}
 ${workflowStatusSource}
 function render() {
  root.replaceChildren(); root.setAttribute("aria-busy", "false");
  const enterprise = enterprises.find(e => e.enterpriseKey === config.enterpriseKey);
  root.append(el("section", { class: "panel" }, heading({ zh: enterprise.enterpriseName, en: enterprise.enterpriseName }), pair("noReadAccess", "p"), el("div", { class: "actions" }, button("refresh", refresh))));
  const nav = el("nav", { class: "tabs", "aria-label": text("title"), "data-aria-zh": config.copy.title.zh, "data-aria-en": config.copy.title.en });
  for (const type of types) { const tab = button(type, () => { controller.select(type); render(); }); tab.setAttribute("aria-current", controller.state.selected === type ? "page" : "false"); nav.append(tab); }
  root.append(nav);
  const state = controller.state, view = state.views[state.selected], draft = state.drafts[state.selected];
  if (view?.capability) root.append(el("p", {}, pair("minimumLauncher"), ": " + view.capability.minimumLauncherVersion));
  const source = el("details", { class: "panel" }, el("summary", {}, pair("integration")));
  renderIntegration(source, state.integration); root.append(source);
  const settings = el("section", { class: "panel" }); renderConfiguration(settings, draft); root.append(settings);
  const auth = el("section", { class: "panel" }); renderAuthorizations(auth, view, draft); root.append(auth);
  const controls = el("section", { class: "panel" }); renderControl(controls, view); root.append(controls);
  const status = el("section", { class: "panel" }); root.append(status); renderStatus(status, view).catch(showError);
  updateButtons();
 }
 async function initialize() {
  const [enterpriseResult, storeResult] = await Promise.all([http("/enterprises"), http("/stores")]);
  enterprises = enterpriseResult.enterprises; stores = storeResult.stores.filter(s => s.enterpriseKey === config.enterpriseKey);
  if (!config.enterpriseKey) {
   const choice = select([{ value: "", label: config.copy.choose }, ...enterprises.map(e => ({ value: e.enterpriseKey, label: { zh: e.enterpriseName, en: e.enterpriseName } }))], "", () => {});
   root.replaceChildren(el("section", { class: "panel" }, field("enterprise", choice), enterprises.length ? null : pair("noEnterprises", "p"), button("title", async () => {
    if (!choice.value) throw { uiKey: "invalid" };
    const result = await request("list_enterprise_workflows", { enterpriseKey: choice.value, limit: 1 });
    const target = new URL(result.setupUrl, location.origin);
    if (target.origin !== location.origin || !target.pathname.startsWith(base + "/workflows/")) throw { uiKey: "security" };
    location.assign(target.href);
   }))); root.setAttribute("aria-busy", "false"); return;
  }
  if (!enterprises.some(e => e.enterpriseKey === config.enterpriseKey)) { frozen = true; throw { code: "BROWSER_ACCESS_DENIED" }; }
  controller = createWorkflowController({ request, enterpriseKey: config.enterpriseKey });
  await controller.load(); controller.select(controller.state.selected); render();
 }
 window.addEventListener("smedc-locale-changed", () => document.querySelectorAll("option[data-option-zh]").forEach(option => { option.textContent = locale() === "zh" ? option.dataset.optionZh : option.dataset.optionEn; }));
 window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
 initialize().catch(error => { root.setAttribute("aria-busy", "false"); showError(error); });
})();`;
