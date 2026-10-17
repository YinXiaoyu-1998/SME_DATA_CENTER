import { permissionModelSource } from "./model.js";
import { catalogEditorSource } from "./catalog-editor.js";
import { accountEditorSource } from "./account-editor.js";
import { documentEditorSource } from "./document-editor.js";

/** Inline script is kept as source so release bundling cannot introduce external runtime helpers. */
export const permissionsClientSource = String.raw`
(() => {
 "use strict";
 const config = JSON.parse(document.getElementById("smedc-ui-config").textContent);
 const copy = config.copy;
 const root = document.getElementById("permissions-app");
 const banner = document.getElementById("permission-global-status");
 const base = "/admin/permissions/" + encodeURIComponent(config.orgId);
 let state = null, frozen = false, conflicted = false, saving = false, selectedTab = "categories";
 let selectedAccountId = "", accountDraft = null, selectedDocument = null, documentDraft = null;
 let formSequence = 0;
 const sections = new Map();
 const locale = () => document.documentElement.lang === "en" ? "en" : "zh";
 const text = key => (copy[key] || copy.unexpected)[locale()];
 const translated = key => copy[key] || copy.unexpected;
 const uid = () => crypto.randomUUID().replaceAll("-", "");
 function el(tag, attrs = {}, ...children) {
   const node = document.createElement(tag);
   for (const [key, value] of Object.entries(attrs)) {
     if (value === false || value === undefined || value === null) continue;
     if (["checked", "disabled", "hidden", "required", "multiple"].includes(key)) node[key] = Boolean(value);
     else node.setAttribute(key, String(value));
   }
   for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)));
   return node;
 }
 function pair(value, tag = "span") {
   const message = typeof value === "string" ? translated(value) : value;
   return el(tag, {}, el("span", { "data-locale": "zh-CN", hidden: locale() !== "zh" }, message.zh), el("span", { "data-locale": "en", hidden: locale() !== "en" }, message.en));
 }
 function heading(key, level = "h2") { return pair(key, level); }
 function button(key, handler, className = "secondary", write = false) {
   const node = el("button", { type: "button", class: className, "data-write": write ? "true" : undefined }, pair(key));
   node.addEventListener("click", () => Promise.resolve().then(handler).catch(error => showError(error)));
   return node;
 }
 function field(key, control) {
   const id = "permission-field-" + (++formSequence);
   control.id = id;
   return el("div", { "data-field": typeof key === "string" ? key : undefined }, el("label", { for: id }, pair(key)), control);
 }
 function input(value = "", max = 255) { const node = el("input", { type: "text", maxlength: max }); node.value = value; return node; }
 function select(choices, value = "") {
   const node = el("select");
   for (const choice of choices) {
     const label = typeof choice.label === "string" ? { zh: choice.label, en: choice.label } : choice.label;
     const option = el("option", { value: choice.value, disabled: choice.disabled, "data-option-zh": label.zh, "data-option-en": label.en }, label[locale()]);
     node.append(option);
   }
   node.value = String(value ?? "");
   return node;
 }
 const blank = () => ({ value: "", label: translated("choose") });
 const levels = value => select([{ value: "", label: translated("unset") }, ...[0,1,2,3].map(level => ({ value: String(level), label: String(level) }))], value);
 function check(key, checked = false) {
   const control = el("input", { type: "checkbox", checked });
   return { control, node: el("label", { class: "check" }, control, pair(key)) };
 }
 function checklist(key, choices, selected = [], changed) {
   const container = el("fieldset", {}, el("legend", {}, pair(key)));
   const controls = new Map();
   for (const choice of choices) {
     const option = check(choice.label, selected.includes(choice.value));
     option.control.disabled = Boolean(choice.disabled && !option.control.checked);
     controls.set(choice.value, option.control); container.append(option.node);
     if (changed) option.control.addEventListener("change", () => changed([...controls].filter(([, control]) => control.checked).map(([value]) => value)));
   }
   return { node: container, read: () => [...controls].filter(([, control]) => control.checked).map(([value]) => value) };
 }
 function status(node, key, isError = false) { node.replaceChildren(pair(key)); node.className = isError ? "error" : "muted"; node.hidden = false; }
 function showGlobal(key, isError = false, reference) {
   banner.replaceChildren(pair(key)); banner.className = isError ? "notice error" : "notice"; banner.hidden = false;
   if (reference && /^[A-Za-z0-9_-]{1,128}$/.test(reference)) banner.append(el("p", {}, pair("requestReference"), ": " + reference));
   if (frozen) banner.append(el("p", {}, el("a", { href: base + "/login" }, pair("signIn"))));
   if (conflicted) banner.append(button("compare", compareLatest));
 }
 function errorKey(code) {
   if (code === "AUTHORIZATION_VERSION_CONFLICT") return "conflict";
   if (code === "ENTERPRISE_NAME_REQUIRED") return "enterpriseNameRequired";
   if (code === "ENTERPRISE_NAME_CONFLICT") return "enterpriseNameConflict";
   if (code === "BROWSER_SIGN_IN_REQUIRED") return "expired";
   if (["BROWSER_ACCESS_DENIED", "AUTHORIZATION_ADMIN_REQUIRED"].includes(code)) return "denied";
   if (code === "BROWSER_SECURITY_CHECK_FAILED") return "security";
   if (code === "AUTHORIZATION_CUTOVER_NOT_READY") return "notReady";
   if (code === "AUTHORIZATION_SUSPENDED") return "suspendedHelp";
   if (code === "AUTHORIZATION_NOT_ENABLED") return "invalid";
   if (["RESOURCE_NOT_FOUND", "AUTHORIZATION_ACCOUNT_NOT_FOUND", "CATEGORY_NOT_FOUND"].includes(code)) return "unavailable";
   if (code && code.startsWith("INVALID_")) return "invalid";
   return "unexpected";
 }
 function showError(error, target) {
   const key = errorKey(error.code);
   if (target) status(target, key, true);
   showGlobal(key, true, error.requestId);
 }
 function updateButtons() { root.querySelectorAll('[data-write="true"]').forEach(node => { node.disabled = frozen || conflicted || saving; }); }
 async function request(path, method = "GET", body) {
   if (method !== "GET" && (frozen || conflicted)) throw { code: conflicted ? "AUTHORIZATION_VERSION_CONFLICT" : "BROWSER_SIGN_IN_REQUIRED" };
   let response;
   try { response = await fetch(base + "/api" + path, { method, credentials: "same-origin", headers: { ...(method !== "GET" ? { "content-type": "application/json", "x-csrf-token": config.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
   catch { throw { code: "NETWORK_ERROR" }; }
   let value;
   try { value = await response.json(); } catch { throw { code: "INVALID_RESPONSE" }; }
   if (!response.ok) {
     const error = value.error || { code: "UNEXPECTED_RESPONSE" };
     if (response.status === 401 || response.status === 403) frozen = true;
     if (error.code === "AUTHORIZATION_VERSION_CONFLICT") conflicted = true;
     updateButtons(); throw error;
   }
   return value;
 }
 async function fetchBundle() {
   const [me, categories, stores, dimensions, accounts, enterprises] = await Promise.all([request("/me"), request("/categories"), request("/stores"), request("/dimensions"), request("/accounts"), request("/enterprises")]);
   const versions = [me.authorizationVersion, categories.authorizationVersion, stores.authorizationVersion, dimensions.authorizationVersion, enterprises.authorizationVersion, ...accounts.accounts.map(account => account.authorizationVersion)];
   if (versions.some(version => version !== me.authorizationVersion)) { conflicted = true; throw { code: "AUTHORIZATION_VERSION_CONFLICT" }; }
   return { me, version: me.authorizationVersion, categories: categories.categories, stores: stores.stores, dimensions: dimensions.dimensions, accounts: accounts.accounts, enterprises: enterprises.enterprises };
 }
 function dirty(form) { form.dataset.dirty = "true"; }
 function hasDirty(container = root) { return Boolean(container.querySelector('[data-dirty="true"]')); }
 function formWithStatus() {
   const form = el("form", { novalidate: "" });
   const message = el("p", { role: "status", hidden: true });
   form.addEventListener("input", () => dirty(form)); form.addEventListener("change", () => dirty(form));
   return { form, message };
 }
 function onSubmit(form, message, handler) {
   form.addEventListener("submit", event => { event.preventDefault(); Promise.resolve().then(handler).catch(error => showError(error, message)); });
   form.append(el("div", { class: "actions" }, el("button", { type: "submit", "data-write": "true" }, pair("save"))), message);
   updateButtons();
 }
 async function confirmDialog(titleKey, content, actionKey = "confirm", cancelKey = "cancel") {
   const dialog = el("dialog", { "aria-labelledby": "permissions-dialog-title" });
   const title = heading(titleKey); title.id = "permissions-dialog-title";
   const details = el("div", { class: "summary" }, pair(content));
   return new Promise(resolve => {
     const close = value => { dialog.close(); dialog.remove(); resolve(value); };
     const cancel = button(cancelKey, () => close(false));
     const confirm = button(actionKey, () => close(true), "");
     dialog.append(title, details, el("div", { class: "actions" }, cancel, confirm));
     dialog.addEventListener("cancel", event => { event.preventDefault(); close(false); });
     document.body.append(dialog); dialog.showModal(); cancel.focus();
   });
 }
 function categoryLabel(category) { return category.kind === "fixed" && copy[category.key] ? copy[category.key] : { zh: category.name, en: category.name }; }
 function itemLabel(item) { return { zh: item.name + (item.retired ? "（" + copy.retired.zh + "）" : ""), en: item.name + (item.retired ? " (" + copy.retired.en + ")" : "") }; }
 const categoryName = (id, lang) => { const item = state.categories.find(category => category.id === id); return item ? categoryLabel(item)[lang] : copy.preserved[lang]; };
 const dimensionName = (id, lang) => { const item = state.dimensions.find(dimension => dimension.id === id); return item ? item.name : copy.preserved[lang]; };
 const valueName = (id, value, lang) => { const dimension = state.dimensions.find(item => item.id === id); const item = dimension && dimension.values.find(item => item.id === value); return item ? item.name : copy.preserved[lang]; };
 function grantDescription(grant, lang) {
   const stores = grant.ownership === "group" ? copy.group[lang] : grant.stores && grant.stores.kind === "all" ? copy.allStores[lang] : (grant.stores && grant.stores.values || []).join(", ");
   const dimensions = Object.entries(grant.dimensions).map(([id, selection]) => dimensionName(id, lang) + ": " + (selection.kind === "all" ? copy.allValues[lang] : selection.values.map(value => valueName(id, value, lang)).join(", "))).join("; ");
   const business = state.enterprises.find(enterprise => enterprise.enterpriseKey === grant.enterpriseKey);
   return (business ? business.enterpriseName : grant.enterpriseKey) + " · " + grant.categoryIds.map(id => categoryName(id, lang)).join(", ") + " · " + stores + (dimensions ? " · " + dimensions : "");
 }
 function accountSummary(account, lang) { return account.displayName + " · " + copy.clearance[lang] + ": " + account.clearance + "\n" + (account.grants.length ? account.grants.map(grant => grantDescription(grant, lang)).join("\n") : copy.noGrants[lang]); }
 function summaryPair(name, before, after) { return { zh: name + "\n" + copy.before.zh + ": " + before.zh + "\n" + copy.after.zh + ": " + after.zh, en: name + "\n" + copy.before.en + ": " + before.en + "\n" + copy.after.en + ": " + after.en }; }
 async function saveChange(form, message, path, method, before, after, summary, applied) {
   if (frozen || conflicted || saving) return;
   if (!model.changed(before, after)) { status(message, "noChange"); return; }
   const expectedVersion = state.version;
   if (!await confirmDialog("changeTitle", summary)) return;
   if (frozen || conflicted || saving) return;
   saving = true; updateButtons(); status(message, "saving");
   try {
     const result = await request(path, method, { ...after, expectedVersion });
     state.version = result.authorizationVersion;
     applied(result); form.dataset.dirty = "false"; status(message, "saved"); updateBadge();
   } catch (error) { showError(error, message); }
   finally { saving = false; updateButtons(); }
 }
 function bundleSummary(bundle, lang) {
   return copy.version[lang] + ": " + bundle.version + "\n" + bundle.categories.map(category => (category.kind === "fixed" ? (copy[category.key] || { zh: category.name, en: category.name })[lang] + ": " + (category.confidentialityLevel ?? copy.unset[lang]) : category.name)).join("\n") + "\n\n" + bundle.accounts.map(account => accountSummary(account, lang)).join("\n\n");
 }
 function dirtySummary(lang) {
   return [...root.querySelectorAll('[data-dirty="true"]')].map(form => {
     const labels = [...form.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(control => control.type !== "checkbox" || control.checked).map(control => {
       const label = control.id && form.querySelector('label[for="' + control.id + '"]');
       const name = label && label.querySelector('[data-locale="' + (lang === "zh" ? "zh-CN" : "en") + '"]');
       const value = control.tagName === "SELECT" ? [...control.selectedOptions].map(option => lang === "zh" ? option.dataset.optionZh : option.dataset.optionEn).join(", ") : control.type === "checkbox" ? copy.active[lang] : control.value;
       return (name ? name.textContent + ": " : "") + value;
     });
     return labels.join("; ");
   }).join("\n") + (accountDraft ? "\n" + accountSummary(accountDraft, lang) : "");
 }
 async function compareLatest() {
   const latest = await fetchBundle();
   const content = { zh: copy.discardHelp.zh + "\n\n" + copy.latest.zh + "\n" + bundleSummary(latest, "zh") + "\n\n" + copy.draft.zh + "\n" + dirtySummary("zh"), en: copy.discardHelp.en + "\n\n" + copy.latest.en + "\n" + bundleSummary(latest, "en") + "\n\n" + copy.draft.en + "\n" + dirtySummary("en") };
   if (await confirmDialog("discardTitle", content, "discard", "keepDraft")) applyBundle(latest);
 }
 async function reloadAll() {
   if (hasDirty() || conflicted) return compareLatest();
   applyBundle(await fetchBundle());
 }
 function updateBadge() {
   const badge = document.getElementById("permission-mode");
   if (badge) badge.replaceChildren(pair(state.me.mode));
   const version = document.getElementById("permission-version");
   if (version) version.textContent = state.version;
 }
 async function openTab(key) {
   selectedTab = key;
   for (const [name, section] of sections) section.hidden = name !== key;
   root.querySelectorAll('[role="tab"]').forEach(tab => { const chosen = tab.dataset.tab === key; tab.setAttribute("aria-selected", String(chosen)); tab.tabIndex = chosen ? 0 : -1; });
   const section = sections.get(key);
   if (!section.dataset.built || (section.dataset.built !== state.version && !hasDirty(section))) {
     section.replaceChildren(); section.dataset.built = state.version;
     if (key === "categories") renderCategories(section);
     if (key === "stores") renderStores(section);
     if (key === "dimensions") renderDimensions(section);
     if (key === "accounts") renderAccounts(section);
     if (key === "documents") await renderDocuments(section);
     if (key === "readiness") renderReadiness(section);
   }
   updateButtons();
 }
 function applyBundle(bundle) {
   state = bundle; conflicted = false; frozen = false; selectedDocument = null; documentDraft = null; accountDraft = null;
   root.replaceChildren(); root.className = ""; sections.clear(); banner.hidden = true;
   const version = el("span", { id: "permission-version" }, state.version);
   root.append(el("div", { class: "panel" }, el("span", { id: "permission-mode", class: "step" }, pair(state.me.mode)), pair("intro", "p"), el("small", {}, pair("version"), ": ", version), el("div", { class: "actions" }, button("refresh", reloadAll))));
   const navigation = el("div", { class: "tabs", role: "tablist", "aria-label": locale() === "zh" ? "权限设置区域" : "Permission settings sections", "data-aria-zh": "权限设置区域", "data-aria-en": "Permission settings sections" });
   for (const key of ["categories", "stores", "dimensions", "accounts", "documents", "readiness"]) {
     const tab = button(key, () => openTab(key)); tab.setAttribute("role", "tab"); tab.dataset.tab = key; tab.id = "tab-" + key; tab.setAttribute("aria-controls", "panel-" + key); navigation.append(tab);
     const section = el("section", { id: "panel-" + key, class: "panel", role: "tabpanel", "aria-labelledby": tab.id, hidden: true }); sections.set(key, section);
   }
   navigation.addEventListener("keydown", event => {
     const tabs = [...navigation.querySelectorAll('[role="tab"]')]; const index = tabs.indexOf(event.target);
     if (index < 0) return;
     const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
     if (next >= 0) { event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
   });
   root.append(navigation, ...sections.values());
   openTab(selectedTab).catch(showError);
 }
 ${permissionModelSource}
 ${catalogEditorSource}
 ${accountEditorSource}
 ${documentEditorSource}
 function renderReadiness(section) {
   section.append(heading("readiness"), pair("activateHelp", "p"), pair("noDataClaim", "p"));
   const report = el("div");
   section.append(button("check", async () => {
     const result = await request("/cutover");
     if (result.authorizationVersion !== state.version) { conflicted = true; updateButtons(); throw { code: "AUTHORIZATION_VERSION_CONFLICT" }; }
     report.replaceChildren(heading(result.ready ? "ready" : "notReady", "h3"));
     if (result.missing.length) {
       const table = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, pair("issue")), el("th", {}, pair("target")))));
       const body = el("tbody");
       for (const issue of result.missing) {
         const account = state.accounts.find(item => issue.targetId === item.id || issue.targetId.startsWith(item.id + "/"));
         const category = state.categories.find(item => item.id === issue.targetId || item.key === issue.targetId);
         const target = account ? account.displayName : category ? categoryLabel(category) : issue.targetId;
         body.append(el("tr", {}, el("td", {}, pair(copy[issue.code] ? issue.code : "invalid")), el("td", {}, typeof target === "string" ? target : pair(target))));
       }
       table.append(body); report.append(el("div", { class: "table-wrap" }, table));
     }
     if (result.accountsWithoutGrants.length) report.append(pair("accountsWithoutGrants", "p"), el("ul", {}, ...result.accountsWithoutGrants.map(id => el("li", {}, (state.accounts.find(account => account.id === id) || { displayName: id }).displayName))));
     if (result.mode === "enabled") { report.append(pair("alreadyEnabled", "p")); return; }
     if (result.mode === "suspended") { report.append(pair("suspendedHelp", "p")); return; }
     if (result.ready) report.append(button("activate", async () => {
       if (hasDirty()) { showGlobal("discardHelp", true); return; }
       if (!await confirmDialog("activate", translated("activateHelp"), "activate")) return;
       if (frozen || conflicted || saving) return;
       saving = true; updateButtons();
       try { const saved = await request("/cutover/activate", "POST", { expectedVersion: result.authorizationVersion, confirm: true }); state.version = saved.authorizationVersion; state.me.mode = "enabled"; updateBadge(); report.replaceChildren(pair("activated", "p")); showGlobal("activated"); }
       finally { saving = false; updateButtons(); }
     }, "", true));
     updateButtons();
   }), report);
   if (state.me.mode === "enabled") section.append(pair("alreadyEnabled", "p"));
   if (state.me.mode === "suspended") section.append(pair("suspendedHelp", "p"));
 }
 window.addEventListener("smedc-locale-changed", () => {
   document.querySelectorAll("option[data-option-zh]").forEach(option => { option.textContent = locale() === "zh" ? option.dataset.optionZh : option.dataset.optionEn; });
 });
 reloadAll().catch(error => { showError(error); root.replaceChildren(button("refresh", reloadAll)); });
})();`;
