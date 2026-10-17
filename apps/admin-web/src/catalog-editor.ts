import { FIXED_BUSINESS_CATEGORY_KEYS } from "@smedc/domain";
export const catalogEditorSource = String.raw`
function selectedDimensionChoices(selected = []) {
  const choices = state.dimensions.map(dimension => ({ value: dimension.id, label: itemLabel(dimension), disabled: dimension.retired }));
  for (const id of selected) if (!choices.some(choice => choice.value === id)) choices.push({ value: id, label: translated("preserved") });
  return choices;
}
function renderCategories(section) {
  section.append(heading("categories"), pair("fixedHelp", "p"), pair("levelHelp", "p"));
  if (${JSON.stringify(FIXED_BUSINESS_CATEGORY_KEYS)}.some(key => !state.categories.some(category => category.kind === "fixed" && category.key === key))) {
    const message = el("p", { hidden: true, role: "status" });
    section.append(pair("initializeCategoriesHelp", "p"), button("initializeCategories", async () => {
      if (hasDirty()) { status(message, "initializeDrafts", true); return; }
      if (frozen || conflicted || saving) return;
      const expectedVersion = state.version;
      if (!await confirmDialog("initializeCategories", copy.initializeCategoriesHelp)) return;
      if (frozen || conflicted || saving || hasDirty()) return;
      saving = true; updateButtons();
      try {
        const result = await request("/categories/initialize", "POST", { expectedVersion });
        state.version = result.authorizationVersion; updateBadge();
        applyBundle(await fetchBundle());
      } catch (error) { showError(error, message); }
      finally { saving = false; updateButtons(); }
    }, "secondary", true), message);
  }
  for (const category of state.categories.filter(category => category.kind === "fixed" && category.key !== "delivery_ledger")) {
    const { form, message } = formWithStatus(); form.className = "subpanel";
    form.append(heading(categoryLabel(category), "h3"));
    const level = levels(category.confidentialityLevel ?? ""); form.append(field("level", level));
    let baseline = { name: category.name, confidentialityLevel: category.confidentialityLevel, retired: category.retired };
    onSubmit(form, message, async () => {
      if (level.value === "") { status(message, "required", true); return; }
      const after = { ...baseline, confidentialityLevel: Number(level.value) };
      await saveChange(form, message, "/categories/" + encodeURIComponent(category.id), "PATCH", baseline, after,
        summaryPair(categoryLabel(category).zh + " / " + categoryLabel(category).en, { zh: String(baseline.confidentialityLevel ?? copy.unset.zh), en: String(baseline.confidentialityLevel ?? copy.unset.en) }, { zh: level.value, en: level.value }),
        result => { baseline = after; Object.assign(category, result.value || after); });
    });
    section.append(form);
  }
  section.append(heading("documentCategory"), pair("evidenceHelp", "p"));
  const list = el("div"); section.append(list);
  for (const category of state.categories.filter(category => category.kind === "evidence")) list.append(categoryForm(category));
  const addForm = () => {
    const form = categoryForm(null, () => { addForm(); }); list.append(form);
  };
  addForm();
}
function categoryForm(existing, onCreated) {
  let category = existing || { id: uid(), name: "", kind: "evidence", allowStore: false, allowGroup: false, dimensions: [], retired: false };
  let isNew = !existing;
  const { form, message } = formWithStatus(); form.className = "subpanel";
  const title = existing ? el("h3", {}, existing.name) : heading("addCategory", "h3");
  const name = input(category.name);
  const store = check("store", category.allowStore), group = check("group", category.allowGroup), retired = check("retire", category.retired);
  const dimensions = checklist("requiredConditions", selectedDimensionChoices(category.dimensions.map(item => item.dimensionId)), category.dimensions.map(item => item.dimensionId));
  const read = () => ({ name: name.value, ownerships: [...(store.control.checked ? ["store"] : []), ...(group.control.checked ? ["group"] : [])], requiredDimensionIds: dimensions.read(), retired: retired.control.checked });
  let baseline = read();
  form.append(title, field("name", name), el("fieldset", {}, el("legend", {}, pair("ownership")), store.node, group.node), dimensions.node, retired.node);
  onSubmit(form, message, async () => {
    const after = read();
    if (!after.name.trim() || !after.ownerships.length) { status(message, "required", true); return; }
    const describe = (value, lang) => value.name + " · " + value.ownerships.map(key => copy[key][lang]).join(", ") + " · " + value.requiredDimensionIds.map(id => dimensionName(id, lang)).join(", ") + (value.retired ? " · " + copy.retired[lang] : "");
    await saveChange(form, message, "/categories" + (isNew ? "" : "/" + encodeURIComponent(category.id)), isNew ? "POST" : "PATCH", isNew ? null : baseline, { ...after, ...(isNew ? { id: category.id, kind: "evidence" } : {}) }, summaryPair(after.name, { zh: isNew ? copy.empty.zh : describe(baseline, "zh"), en: isNew ? copy.empty.en : describe(baseline, "en") }, { zh: describe(after, "zh"), en: describe(after, "en") }), result => {
      const saved = result.value || { ...category, ...after, allowStore: after.ownerships.includes("store"), allowGroup: after.ownerships.includes("group"), dimensions: after.requiredDimensionIds.map(dimensionId => ({ dimensionId })) };
      if (isNew) { state.categories.push(saved); category = saved; } else Object.assign(category, saved);
      baseline = after; title.replaceChildren(after.name);
      if (isNew) { isNew = false; onCreated && onCreated(); }
    });
  });
  return form;
}
function renderDimensions(section) {
  section.append(heading("dimensions"), pair("dimensionHelp", "p"));
  const list = el("div"); section.append(list);
  for (const dimension of state.dimensions) list.append(dimensionCard(dimension));
  const add = () => list.append(dimensionCard(null, add)); add();
}
function dimensionCard(existing, onCreated) {
  let dimension = existing || { id: uid(), name: "", retired: false, values: [] }; let isNew = !existing;
  const card = el("div", { class: "subpanel" });
  const { form, message } = formWithStatus(); const name = input(dimension.name); const retired = check("retire", dimension.retired);
  const title = existing ? el("h3", {}, dimension.name) : heading("addDimension", "h3");
  let baseline = { name: dimension.name, retired: dimension.retired };
  form.append(title, field("name", name), retired.node);
  const valuesArea = el("div", { hidden: isNew });
  function addValueForm(value, created) {
    let isValueNew = !value; let record = value || { id: uid(), name: "", retired: false };
    const entry = formWithStatus(), valueNameInput = input(record.name), valueRetired = check("retire", record.retired);
    entry.form.className = "subpanel"; const valueTitle = value ? el("h3", {}, record.name) : heading("addValue", "h3");
    let original = { name: record.name, retired: record.retired };
    entry.form.append(valueTitle, field("name", valueNameInput), valueRetired.node);
    onSubmit(entry.form, entry.message, async () => {
      const after = { name: valueNameInput.value, retired: valueRetired.control.checked };
      if (!after.name.trim()) { status(entry.message, "required", true); return; }
      await saveChange(entry.form, entry.message, "/dimensions/" + encodeURIComponent(dimension.id) + "/values" + (isValueNew ? "" : "/" + encodeURIComponent(record.id)), isValueNew ? "POST" : "PATCH", isValueNew ? null : original, { ...after, ...(isValueNew ? { id: record.id } : {}) }, summaryPair(dimension.name, { zh: original.name + (original.retired ? " · " + copy.retired.zh : ""), en: original.name + (original.retired ? " · " + copy.retired.en : "") }, { zh: after.name + (after.retired ? " · " + copy.retired.zh : ""), en: after.name + (after.retired ? " · " + copy.retired.en : "") }), result => {
        const saved = result.value || { ...record, ...after };
        if (isValueNew) { dimension.values.push(saved); record = saved; } else Object.assign(record, saved);
        original = after; valueTitle.replaceChildren(after.name);
        if (isValueNew) { isValueNew = false; created && created(); }
      });
    });
    valuesArea.append(entry.form);
  }
  valuesArea.append(heading("values", "h3"));
  for (const value of dimension.values) addValueForm(value);
  const add = () => addValueForm(null, add); add();
  onSubmit(form, message, async () => {
    const after = { name: name.value, retired: retired.control.checked };
    if (!after.name.trim()) { status(message, "required", true); return; }
    await saveChange(form, message, "/dimensions" + (isNew ? "" : "/" + encodeURIComponent(dimension.id)), isNew ? "POST" : "PATCH", isNew ? null : baseline, { ...after, ...(isNew ? { id: dimension.id } : {}) }, summaryPair(after.name, { zh: baseline.name + (baseline.retired ? " · " + copy.retired.zh : ""), en: baseline.name + (baseline.retired ? " · " + copy.retired.en : "") }, { zh: after.name + (after.retired ? " · " + copy.retired.zh : ""), en: after.name + (after.retired ? " · " + copy.retired.en : "") }), result => {
      const saved = result.value || { ...dimension, ...after };
      const values = dimension.values;
      if (isNew) state.dimensions.push({ ...saved, values }); else Object.assign(dimension, saved);
      dimension = state.dimensions.find(item => item.id === dimension.id); dimension.values = values;
      baseline = after; title.replaceChildren(after.name); valuesArea.hidden = false;
      if (isNew) { isNew = false; onCreated && onCreated(); }
    });
  });
  card.append(form, valuesArea); return card;
}
function enterpriseChoices(value = "") {
  const choices = [blank(), ...state.enterprises.map(item => ({ value: item.enterpriseKey, label: item.enterpriseName }))];
  if (value && !choices.some(choice => choice.value === value)) choices.push({ value, label: value });
  return choices;
}
function enterpriseSelect(value = "", allowNew = false) {
  const choices = enterpriseChoices(value).map(choice => allowNew && choice.value ? { ...choice, value: "existing:" + choice.value } : choice);
  if (allowNew) choices.push({ value: "new", label: translated("newEnterprise") });
  const control = select(choices, allowNew && value ? "existing:" + value : value);
  control.dataset.enterpriseSelect = "true";
  if (allowNew) control.dataset.allowNewEnterprise = "true";
  return control;
}
function refreshEnterpriseOptions() {
  root.querySelectorAll('[data-enterprise-select="true"]').forEach(control => {
    const value = control.value, allowNew = control.dataset.allowNewEnterprise === "true";
    const key = allowNew ? (value.startsWith("existing:") ? value.slice(9) : "") : value;
    const fresh = enterpriseSelect(key, allowNew); control.replaceChildren(...fresh.children); control.value = value;
  });
}
function renderStores(section) {
  section.append(heading("stores"), pair("enterpriseHelp", "p"), pair("storeHelp", "p"));
  const declaration = formWithStatus(); const businessName = input(); declaration.form.className = "subpanel";
  declaration.form.append(heading("declareEnterprise", "h3"), field("enterpriseName", businessName));
  onSubmit(declaration.form, declaration.message, async () => {
      if (!businessName.value.trim()) { status(declaration.message, "required", true); return; }
      const name = businessName.value;
      const content = { zh: name + "\n" + copy.enterpriseDeclared.zh, en: name + "\n" + copy.enterpriseDeclared.en };
      await saveChange(declaration.form, declaration.message, "/enterprises", "POST", null, { name }, content, result => {
        const existing = state.enterprises.find(item => item.enterpriseKey === result.value.enterpriseKey);
        if (existing) Object.assign(existing, result.value); else state.enterprises.push(result.value);
        businessName.value = ""; refreshEnterpriseOptions();
      });
  });
  section.append(declaration.form);
  const list = el("div"); section.append(list);
  function existingStore(store) {
    const item = formWithStatus(); item.form.className = "subpanel";
    const retired = check("retire", store.retired);
    const business = state.enterprises.find(enterprise => enterprise.enterpriseKey === store.enterpriseKey);
    item.form.append(el("h3", {}, store.name), el("p", { class: "muted" }, business ? business.enterpriseName : store.enterpriseKey), retired.node);
    let baseline = { enterpriseKey: store.enterpriseKey, name: store.name, retired: store.retired };
    onSubmit(item.form, item.message, async () => {
      const after = { ...baseline, retired: retired.control.checked };
      await saveChange(item.form, item.message, "/stores", "POST", baseline, after, summaryPair(store.name, translated(baseline.retired ? "retired" : "active"), translated(after.retired ? "retired" : "active")), result => { baseline = after; Object.assign(store, result.value || after); });
    });
    list.append(item.form);
  }
  for (const store of state.stores) existingStore(store);
  const creation = formWithStatus(); const enterprise = enterpriseSelect("", true), name = input(), newEnterpriseName = input(); creation.form.className = "subpanel";
  const newEnterpriseField = field("enterpriseName", newEnterpriseName);
  const toggleEnterpriseName = () => { newEnterpriseField.hidden = enterprise.value !== "new"; };
  if (!state.enterprises.length) enterprise.value = "new";
  enterprise.addEventListener("change", toggleEnterpriseName); toggleEnterpriseName();
  creation.form.append(heading("addStore", "h3"), field("enterprise", enterprise), newEnterpriseField, pair("automaticEnterpriseHelp", "p"), field("storeName", name));
  onSubmit(creation.form, creation.message, async () => {
    const isNew = enterprise.value === "new";
    if (!enterprise.value || !name.value.trim() || (isNew && !newEnterpriseName.value.trim())) { status(creation.message, "required", true); return; }
    const identity = isNew ? await request("/enterprises/preview", "POST", { name: newEnterpriseName.value }) : state.enterprises.find(item => item.enterpriseKey === enterprise.value.slice(9));
    if (!identity) { status(creation.message, "enterpriseNameRequired", true); return; }
    if (state.stores.some(store => store.enterpriseKey === identity.enterpriseKey && store.name === name.value)) { status(creation.message, "invalid", true); return; }
    const after = { enterpriseKey: identity.enterpriseKey, ...(isNew ? { enterpriseName: identity.enterpriseName } : {}), name: name.value, retired: false };
    await saveChange(creation.form, creation.message, "/stores", "POST", null, after, { zh: identity.enterpriseName + " · " + after.name, en: identity.enterpriseName + " · " + after.name }, result => {
      const saved = result.value; state.stores.push(saved);
      if (!state.enterprises.some(item => item.enterpriseKey === saved.enterpriseKey)) state.enterprises.push({ enterpriseKey: saved.enterpriseKey, enterpriseName: saved.enterpriseName });
      existingStore(saved);
      refreshEnterpriseOptions(); enterprise.value = "existing:" + saved.enterpriseKey; toggleEnterpriseName(); name.value = ""; newEnterpriseName.value = "";
    });
  });
  section.append(creation.form);
}`;
