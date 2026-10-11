export const documentEditorSource = String.raw`
async function renderDocuments(section) {
  section.append(heading("documents"), pair("documentHelp", "p"), pair("supplementHelp", "p"));
  const searchForm = el("form", { novalidate: "" }), search = input("", 256);
  searchForm.append(field("searchDocument", search), el("div", { class: "actions" }, el("button", { type: "submit" }, pair("search"))));
  const list = el("div"), editor = el("div"), pagination = el("div", { class: "actions" });
  let cursor = null, nextCursor = null, currentSearch = "";
  async function discardCurrent() {
    if (!hasDirty(editor)) return true;
    return confirmDialog("discardTitle", translated("discardHelp"), "discard", "keepDraft");
  }
  async function load(after = null) {
    const query = new URLSearchParams(); if (currentSearch) query.set("search", currentSearch); if (after) query.set("cursor", after);
    const result = await request("/documents" + (query.size ? "?" + query.toString() : ""));
    if (result.authorizationVersion !== state.version) { conflicted = true; updateButtons(); throw { code: "AUTHORIZATION_VERSION_CONFLICT" }; }
    cursor = after; nextCursor = result.nextCursor;
    list.replaceChildren();
    if (!result.documents.length) list.append(pair("empty", "p"));
    else {
      const table = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, pair("document")), el("th", {}, pair("documentStatus")))));
      const body = el("tbody");
      for (const doc of result.documents) {
        const choose = el("button", { type: "button", class: "secondary" }, doc.title);
        choose.addEventListener("click", () => Promise.resolve().then(async () => {
          if (!await discardCurrent()) return;
          selectedDocument = doc; documentDraft = model.clone(doc); editor.replaceChildren(documentForm(doc)); updateButtons();
        }).catch(showError));
        body.append(el("tr", {}, el("td", {}, choose), el("td", {}, pair(copy[doc.status] ? doc.status : "attributesNotReady"))));
      }
      table.append(body); list.append(el("div", { class: "table-wrap" }, table));
    }
    const first = button("firstPage", async () => { if (await discardCurrent()) { editor.replaceChildren(); selectedDocument = null; documentDraft = null; await load(null); } }); first.disabled = !cursor;
    const next = button("nextPage", async () => { if (await discardCurrent()) { editor.replaceChildren(); selectedDocument = null; documentDraft = null; await load(nextCursor); } }); next.disabled = !nextCursor;
    pagination.replaceChildren(first, next);
  }
  searchForm.addEventListener("submit", event => { event.preventDefault(); Promise.resolve().then(async () => { if (!await discardCurrent()) return; currentSearch = search.value; editor.replaceChildren(); selectedDocument = null; documentDraft = null; await load(null); }).catch(showError); });
  section.append(searchForm, list, pagination, editor);
  await load();
}
function documentForm(documentRecord) {
  const { form, message } = formWithStatus(); form.className = "subpanel";
  documentDraft = model.clone(documentRecord);
  const categories = state.categories.filter(category => category.kind === "evidence").map(category => ({ value: category.id, label: itemLabel(category), disabled: category.retired && category.id !== documentRecord.categoryId }));
  if (documentRecord.categoryId && !categories.some(choice => choice.value === documentRecord.categoryId)) categories.push({ value: documentRecord.categoryId, label: translated("preserved") });
  const category = select([blank(), ...categories], documentRecord.categoryId || "");
  const level = levels(documentRecord.fileConfidentialityLevel ?? ""), scopes = el("div"), reason = el("textarea", { rows: "3", maxlength: "2048" });
  let baseline = { categoryId: documentRecord.categoryId, fileConfidentialityLevel: documentRecord.fileConfidentialityLevel, scopes: model.clone(documentRecord.scopes) };
  function currentCategory() { return state.categories.find(item => item.id === documentDraft.categoryId); }
  function renderScopes() {
    scopes.replaceChildren();
    documentDraft.scopes.forEach((scope, index) => scopes.append(documentScopeCard(scope, form, currentCategory, () => { documentDraft.scopes.splice(index, 1); dirty(form); renderScopes(); })));
  }
  category.addEventListener("change", () => { documentDraft.categoryId = category.value; renderScopes(); });
  level.addEventListener("change", () => { documentDraft.fileConfidentialityLevel = level.value === "" ? null : Number(level.value); });
  form.append(el("h3", {}, documentRecord.title), el("p", {}, pair("documentStatus"), ": ", pair(copy[documentRecord.status] ? documentRecord.status : "attributesNotReady")), field("documentCategory", category), field("level", level), heading("scopes", "h3"), scopes, button("addScope", () => { documentDraft.scopes.push({ enterpriseKey: "", ownership: "", dimensions: {} }); dirty(form); renderScopes(); updateButtons(); }, "secondary", true), field("supplementReason", reason));
  const readinessNotice = pair("attributesNotReady", "p"); readinessNotice.hidden = documentRecord.valid; form.append(readinessNotice);
  renderScopes();
  onSubmit(form, message, async () => {
    const rule = currentCategory();
    if (!rule || level.value === "" || !documentDraft.scopes.length || documentDraft.scopes.some(scope => !validDocumentScope(scope, rule))) { status(message, "required", true); return; }
    const after = { categoryId: category.value, fileConfidentialityLevel: Number(level.value), scopes: model.clone(documentDraft.scopes), ...(reason.value.trim() ? { historicalSupplementReason: reason.value } : {}) };
    const describe = (value, lang) => categoryName(value.categoryId, lang) + " · " + copy.level[lang] + ": " + (value.fileConfidentialityLevel ?? copy.unset[lang]) + "\n" + value.scopes.map(scope => scopeDescription(scope, lang)).join("\n") + (value.historicalSupplementReason ? "\n" + copy.supplementReason[lang] + ": " + value.historicalSupplementReason : "");
    await saveChange(form, message, "/documents/" + encodeURIComponent(documentRecord.id), "PATCH", baseline, after, summaryPair(documentRecord.title, { zh: describe(baseline, "zh"), en: describe(baseline, "en") }, { zh: describe(after, "zh"), en: describe(after, "en") }), result => { baseline = { categoryId: after.categoryId, fileConfidentialityLevel: after.fileConfidentialityLevel, scopes: model.clone(after.scopes) }; Object.assign(documentRecord, baseline, { valid: result.value && result.value.valid || false }); documentDraft = { ...model.clone(documentRecord), ...model.clone(baseline) }; reason.value = ""; readinessNotice.hidden = documentRecord.valid; renderScopes(); });
  });
  return form;
}
function scopeDescription(scope, lang) {
  const business = state.enterprises.find(enterprise => enterprise.enterpriseKey === scope.enterpriseKey);
  return (business ? business.enterpriseName : scope.enterpriseKey) + " · " + (scope.ownership === "group" ? copy.group[lang] : scope.storeName || copy.choose[lang]) + " · " + Object.entries(scope.dimensions).map(([id, value]) => dimensionName(id, lang) + ": " + valueName(id, value, lang)).join("; ");
}
function validDocumentScope(scope, category) {
  const required = category.dimensions.map(item => item.dimensionId);
  return Boolean(scope.enterpriseKey && ["store", "group"].includes(scope.ownership) && (scope.ownership === "store" ? category.allowStore && scope.storeName && state.stores.some(store => store.enterpriseKey === scope.enterpriseKey && store.name === scope.storeName) : category.allowGroup && scope.storeName === undefined) && Object.keys(scope.dimensions).length === required.length && required.every(id => Boolean(scope.dimensions[id])));
}
function documentScopeCard(scope, form, currentCategory, removed) {
  const card = el("div", { class: "subpanel" });
  const enterprise = enterpriseSelect(scope.enterpriseKey);
  const category = currentCategory();
  const ownershipChoices = [blank(), ...(category && category.allowStore || scope.ownership === "store" ? [{ value: "store", label: translated("store") }] : []), ...(category && category.allowGroup || scope.ownership === "group" ? [{ value: "group", label: translated("group") }] : [])];
  const ownership = select(ownershipChoices, scope.ownership), storeArea = el("div"), conditions = el("div");
  function renderStore() {
    storeArea.replaceChildren(); if (scope.ownership !== "store") return;
    const choices = [blank(), ...state.stores.filter(store => store.enterpriseKey === scope.enterpriseKey).map(store => ({ value: store.name, label: itemLabel(store), disabled: store.retired && store.name !== scope.storeName }))];
    if (scope.storeName && !choices.some(choice => choice.value === scope.storeName)) choices.push({ value: scope.storeName, label: scope.storeName });
    const store = select(choices, scope.storeName || ""); store.addEventListener("change", () => { scope.storeName = store.value; dirty(form); }); storeArea.append(field("storeName", store));
  }
  enterprise.addEventListener("change", () => { scope.enterpriseKey = enterprise.value; if (scope.ownership === "store") scope.storeName = ""; dirty(form); renderStore(); });
  ownership.addEventListener("change", () => { scope.ownership = ownership.value; if (scope.ownership !== "store") delete scope.storeName; else scope.storeName = scope.storeName || ""; dirty(form); renderStore(); });
  const required = new Set(category ? category.dimensions.map(item => item.dimensionId) : []);
  for (const id of new Set([...required, ...Object.keys(scope.dimensions)])) {
    const dimension = state.dimensions.find(item => item.id === id);
    const choices = [blank(), ...(dimension ? dimension.values : []).map(value => ({ value: value.id, label: itemLabel(value), disabled: value.retired && value.id !== scope.dimensions[id] }))];
    if (scope.dimensions[id] && !choices.some(choice => choice.value === scope.dimensions[id])) choices.push({ value: scope.dimensions[id], label: translated("preserved") });
    const value = select(choices, scope.dimensions[id] || ""); value.addEventListener("change", () => { if (value.value) scope.dimensions[id] = value.value; else delete scope.dimensions[id]; dirty(form); });
    const condition = el("div", {}, field(dimension ? { zh: dimension.name, en: dimension.name } : translated("preserved"), value));
    if (!required.has(id)) condition.append(button("removeCondition", () => { delete scope.dimensions[id]; dirty(form); condition.remove(); }, "secondary", true));
    conditions.append(condition);
  }
  card.append(el("div", { class: "row" }, field("enterprise", enterprise), field("ownership", ownership)), storeArea, conditions, button("removeScope", async () => { if (await confirmDialog("removeScope", { zh: scopeDescription(scope, "zh"), en: scopeDescription(scope, "en") }, "removeScope")) removed(); }, "secondary", true));
  renderStore(); return card;
}`;
