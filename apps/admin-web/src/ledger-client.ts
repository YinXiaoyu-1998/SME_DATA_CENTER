import { ledgerModelSource } from "./ledger-model.js";
import { ledgerControllerSource } from "./ledger-controller.js";
export const ledgerClientSource = String.raw`
(() => {
${ledgerModelSource}
${ledgerControllerSource}
const config = JSON.parse(document.getElementById("ledger-config").textContent);
const limits = config.limits, copy = config.copy;
const $ = id => document.getElementById("ledger-" + id);
const text = (key, values = {}) => {
  const value = copy[key] || copy.INTERNAL_ERROR;
  return (document.documentElement.lang === "en" ? value.en : value.zh).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
};
const el = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
const button = (key, action, disabled = false, focus = key) => { const node = el("button", text(key), "secondary"); node.type = "button"; node.disabled = disabled; node.dataset.focus = focus; node.addEventListener("click", action); return node; };
const size = bytes => {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return bytes === 0 ? "0 B" : text("unknown");
  const unit = bytes >= 1073741824 ? "GiB" : bytes >= 1048576 ? "MiB" : bytes >= 1024 ? "KiB" : "B";
  const divisor = { GiB: 1073741824, MiB: 1048576, KiB: 1024, B: 1 }[unit];
  return (divisor === 1 ? bytes : (bytes / divisor).toFixed(2)) + " " + unit;
};
const exactSize = bytes => size(bytes) + (Number.isSafeInteger(bytes) && bytes > 0 ? " (" + bytes.toLocaleString() + " B)" : "");
function replace(container, ...nodes) {
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  container.replaceChildren(...nodes);
  if (focused) [...container.querySelectorAll("[data-focus]")].find(node => node.dataset.focus === focused)?.focus();
}
function save(url, fileName) {
  const anchor = document.createElement("a"); anchor.href = url; anchor.rel = "noopener";
  if (fileName) anchor.download = fileName;
  document.body.append(anchor); anchor.click(); anchor.remove();
  if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function request(path, body, csrfToken) {
  const response = await fetch("/ledger-pdfs/api/" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: { ...(body === undefined ? {} : { "x-csrf-token": csrfToken }), ...(body && { "content-type": "application/json" }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { const detail = await response.json().catch(() => null); throw { code: detail?.error?.code || "INTERNAL_ERROR" }; }
  if (path.startsWith("pdf?")) {
    if (!response.headers.get("content-type")?.startsWith("application/pdf")) throw { code: "INTERNAL_ERROR" };
    const match = response.headers.get("content-disposition")?.match(/filename\*=UTF-8''([^;]+)/i);
    const fileName = match ? decodeURIComponent(match[1]) : "ledger.pdf";
    return { url: URL.createObjectURL(await response.blob()), fileName };
  }
  return response.json();
}
const client = createLedgerController({ request, limits, changed: render, newKey: () => crypto.randomUUID(), schedule: setTimeout, cancel: clearTimeout, release: url => URL.revokeObjectURL(url), save });
const { state, model } = client;
let previewUrl = null, activeTask = null, resumeWork = null, identity = null;
const dialogTriggers = new Map();
function openDialog(name, trigger) { const dialog = $(name + "-dialog"); dialogTriggers.set(name, trigger || document.activeElement); if (!dialog.open) dialog.showModal(); render(); }
for (const name of ["selection", "task"]) {
  const dialog = $(name + "-dialog");
  dialog.addEventListener("close", () => { dialogTriggers.get(name)?.focus(); });
  document.querySelector('[data-close="' + name + '"]').addEventListener("click", () => dialog.close());
}
function summaryText() { const s = model.summary(); return text("selectedSummary", { ...s, limit: limits.files }); }
function errorText(code) { return text(copy[code] ? code : "INTERNAL_ERROR"); }
function rowActions(item, suffix = "") {
  const actions = el("div", undefined, "ledger-actions");
  const key = ledgerKey(item), blocked = !state.authenticated || state.recovering || item.status !== "ready";
  actions.append(button("preview", () => void client.preview(item), blocked, "preview" + key + suffix), button(state.downloads.has(key) ? "downloading" : "download", () => void client.download(item), blocked || state.downloads.has(key), "download" + key + suffix));
  if (state.notices.has(key)) actions.append(el("span", text(state.notices.get(key)), "notice-line"));
  return actions;
}
function render() {
  const blocked = !state.authenticated || state.recovering;
  const identityKey = state.identity ? JSON.stringify([state.identity.orgId, state.identity.employeeId]) : null;
  if (identity && identityKey !== identity) { $("store").value = ""; activeTask = null; $("task-dialog").close(); }
  identity = identityKey;
  $("identity").textContent = state.identity ? state.identity.organizationName + " · " + state.identity.displayName : "";
  $("logout").disabled = blocked;
  $("session").hidden = !state.recovering && !state.error;
  $("session-text").textContent = state.recovering ? text("recovering") : state.error ? errorText(state.error) : "";
  $("resume").disabled = state.recovering; $("login").hidden = state.recovering;
  $("search").textContent = text(state.querying ? "querying" : "search"); $("search").disabled = blocked || state.querying;
  $("query-error").hidden = !state.queryError; $("query-error").textContent = state.queryError ? errorText(state.queryError) : "";
  $("results").setAttribute("aria-busy", String(state.querying));
  $("list-note").textContent = text("listNote", { count: state.rows.length, limit: limits.pageSize });
  const rows = state.rows.map(item => {
    const tr = el("tr"), checkCell = el("td"), checkbox = document.createElement("input"), key = ledgerKey(item);
    checkbox.type = "checkbox"; checkbox.checked = model.selected.has(key); checkbox.disabled = blocked || item.status !== "ready";
    checkbox.dataset.focus = "check" + key; checkbox.setAttribute("aria-label", text("selectFile", { store: item.storeName, date: item.purchaseDate }));
    checkbox.addEventListener("change", () => { model.select(item, checkbox.checked); render(); }); checkCell.append(checkbox);
    const status = el("td"); status.append(el("span", text(item.status), "ledger-badge " + item.status));
    const actions = el("td"); actions.append(rowActions(item));
    const bytes = el("td", size(item.byteSize)); bytes.title = exactSize(item.byteSize);
    tr.append(checkCell, el("td", item.storeName, "store-name"), el("td", item.purchaseDate, "date"), status, bytes, actions); return tr;
  });
  replace($("rows"), ...rows);
  const ready = state.rows.filter(item => item.status === "ready"), selected = ready.filter(item => model.selected.has(ledgerKey(item))).length;
  $("all").checked = ready.length > 0 && selected === ready.length; $("all").indeterminate = selected > 0 && selected < ready.length; $("all").disabled = blocked || state.querying || !ready.length;
  $("empty").hidden = state.rows.length > 0 || !!state.queryError;
  $("empty").textContent = text(state.querying ? "querying" : state.scope ? "empty" : "initial");
  replace($("stores"), ...[...state.stores].map(name => { const option = document.createElement("option"); option.value = name; return option; }));
  $("prev").disabled = blocked || state.querying || state.batch === 0; $("next").disabled = blocked || state.querying || !state.nextCursor;
  $("batch").textContent = text("batch", { batch: state.batch + 1 });
  const summary = model.summary(); $("selected-summary").textContent = summaryText();
  $("byte-summary").textContent = text("byteSummary", { bytes: exactSize(summary.bytes), remaining: summary.unknown ? text("unknown") : exactSize(summary.remaining), over: exactSize(summary.overBytes) });
  $("capacity").value = Math.min(summary.bytes, limits.bytes);
  const over = summary.files > limits.files || summary.stores > limits.stores || summary.dates > limits.dates || summary.overBytes > 0;
  $("selection-warning").textContent = state.submitError ? errorText(state.submitError) : over ? text("overLimit") : summary.unknown || summary.invalid ? text("unknownSummary", summary) : "";
  $("limit-note").textContent = text("limits", { ...limits, bytes: size(limits.bytes) });
  $("submit").disabled = blocked || state.submitting || !summary.allowed; $("submit").textContent = text(state.submitting ? "preparing" : "prepare"); $("clear").disabled = !summary.files;
  renderPreview(blocked); renderSelection(); renderTasks(blocked);
}
function renderPreview(blocked) {
  const preview = state.preview, frame = $("preview-frame");
  $("preview-close").disabled = !preview;
  replace($("preview-info"), ...(preview ? [el("div", preview.item.storeName + " · " + preview.item.purchaseDate, "ledger-preview-name")] : []));
  if (preview?.url) {
    if (previewUrl !== preview.url) { const iframe = document.createElement("iframe"); iframe.src = preview.url; iframe.title = text("previewTitle") + " · " + preview.item.storeName; frame.replaceChildren(iframe); }
    else frame.querySelector("iframe")?.setAttribute("title", text("previewTitle") + " · " + preview.item.storeName);
  } else replace(frame, el("p", preview?.waiting ? text("previewWaiting") : preview?.error ? errorText(preview.error) : text("previewEmpty"), "empty"));
  previewUrl = preview?.url || null;
  replace($("preview-actions"), ...(preview ? [button("download", () => void client.download(preview.item), blocked || state.downloads.has(ledgerKey(preview.item)), "preview-download"), ...(preview.error ? [button("retry", () => void client.preview(preview.item), blocked, "preview-retry")] : [])] : []));
}
function renderSelection() {
  if (!$("selection-dialog").open) return;
  const items = model.items().map(item => {
    const row = el("div", undefined, "ledger-selected-row"), name = el("span", item.storeName + " · " + item.purchaseDate);
    name.append(el("small", text(item.status))); row.append(name, el("small", exactSize(item.byteSize)), button("remove", () => { model.select(item, false); render(); }, false, "remove" + ledgerKey(item))); return row;
  });
  replace($("selection-body"), el("p", text("selectionOrder")), el("p", text("selectionHint"), "muted"), el("strong", summaryText()), ...items);
  replace($("selection-foot"), button("refresh", () => void resume(), state.recovering), button("clear", () => { model.clear(); render(); }, !model.selected.size));
}
function showTask(task, trigger) { activeTask = task; openDialog("task", trigger); }
function renderTasks(blocked) {
  const records = state.tasks.map(task => {
    const row = el("div", undefined, "ledger-record-row"); row.append(el("span", text("taskSelection", { count: task.selection.length }) + " · " + text(task.status)), button("task", event => showTask(task, event.currentTarget), false, task.requestId)); return row;
  });
  for (const [key, status] of state.notices) {
    const [storeName, purchaseDate] = JSON.parse(key), row = el("div", undefined, "ledger-record-row");
    row.append(el("span", storeName + " · " + purchaseDate + " · " + text(status)), button("download", () => void client.download({ storeName, purchaseDate, status: "ready" }), blocked || state.downloads.has(key), "record" + key)); records.push(row);
  }
  replace($("records"), ...(records.length ? records : [el("p", text("recordsEmpty"), "muted")]));
  if (!$("task-dialog").open || !activeTask) return;
  const task = activeTask;
  const detailsOpen = $("task-body").querySelector("details")?.open;
  const details = el("details"), list = el("div", task.selection.map(item => item.storeName + " · " + item.purchaseDate).join("\n"), "ledger-task-list"); details.open = !!detailsOpen; details.append(el("summary", text("selection")), list);
  const nodes = [el("p", text("taskSelection", { count: task.selection.length })), el("p", text(task.status), "ledger-status"), el("p", text("taskHint", { minutes: limits.deadlineMs / 60000, hours: limits.retentionMs / 3600000 }), "muted")];
  if (task.error) nodes.push(el("p", errorText(task.error), "error"));
  if (task.notice) nodes.push(el("p", text(task.notice)));
  if (task.expiresAt) nodes.push(el("p", text("expires", { time: new Date(task.expiresAt).toLocaleString(document.documentElement.lang) })));
  nodes.push(details); replace($("task-body"), ...nodes);
  replace($("task-foot"), button("refresh", () => void resume(), state.recovering), ...(task.status === "succeeded" ? [button(task.linking ? "linking" : "getLink", () => void client.link(task), blocked || task.linking)] : []), ...(task.error && ["queued", "running"].includes(task.status) ? [button("retry", () => void client.poll(task), blocked || task.waiting)] : []), button("newPrepare", async event => { const trigger = event.currentTarget; await client.submit(true); if (state.activeTask) showTask(state.activeTask, trigger); }, blocked || state.submitting || !model.summary().allowed));
}
function formScope() {
  const startDate = $("start").value, endDate = $("end").value, storeName = $("store").value;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1000-01-01" && value <= "9999-12-31" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate || (storeName && !storeName.trim())) throw { code: "LEDGER_SCOPE_INVALID" };
  if ((Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1 > limits.dates) throw { code: "LEDGER_SCOPE_LIMIT_EXCEEDED" };
  return { startDate, endDate, ...(storeName ? { storeNames: [storeName] } : {}) };
}
async function search() { try { await client.query(formScope()); } catch (error) { state.queryError = error.code || "LEDGER_SCOPE_INVALID"; render(); } }
async function resume(passive = false) {
  if (resumeWork) return resumeWork;
  resumeWork = (async () => { const recovered = await client.resume({ passive }); if (state.authenticated && (!passive || recovered)) await search(); })();
  try { await resumeWork; } finally { resumeWork = null; }
}
$("filter").addEventListener("submit", event => { event.preventDefault(); void search(); });
$("prev").addEventListener("click", () => void client.query(state.scope, state.batch - 1)); $("next").addEventListener("click", () => void client.query(state.scope, state.batch + 1));
$("all").addEventListener("change", event => { model.selectBatch(state.rows.filter(item => item.status === "ready"), event.target.checked); render(); });
$("clear").addEventListener("click", () => { model.clear(); render(); }); $("selected").addEventListener("click", event => openDialog("selection", event.currentTarget));
$("submit").addEventListener("click", async event => { const trigger = event.currentTarget; await client.submit(); if (state.activeTask) showTask(state.activeTask, trigger); });
$("preview-close").addEventListener("click", () => client.closePreview()); $("resume").addEventListener("click", () => void resume());
$("logout").addEventListener("click", async () => {
  try { const response = await fetch("/ledger-pdfs/logout", { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": state.csrfToken } }); if (!response.ok && response.status !== 401) throw { code: "BROWSER_SECURITY_CHECK_FAILED" }; client.expire(); }
  catch (error) { state.error = error.code || "NETWORK_ERROR"; render(); }
});
window.addEventListener("smedc-locale-changed", render);
window.addEventListener("focus", () => { if (!document.hidden) void resume(true); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void resume(true); });
window.addEventListener("pagehide", () => client.expire());
const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
const datePart = type => parts.find(part => part.type === type).value;
const today = datePart("year") + "-" + datePart("month") + "-" + datePart("day");
$("end").value = today; $("start").value = new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0,10);
render(); void resume();
})();`;
