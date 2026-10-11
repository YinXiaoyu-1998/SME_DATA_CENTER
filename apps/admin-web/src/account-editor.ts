export const accountEditorSource = String.raw`
function renderAccounts(section) {
  section.append(heading("accounts"), pair("accountHelp", "p"), pair("levelHelp", "p"), pair("groupHelp", "p"), pair("noGrantOption", "p"));
  const choices = [blank(), ...state.accounts.map(account => ({ value: account.id, label: { zh: account.displayName + " · " + account.email + (account.disabled ? "（" + copy.disabled.zh + "）" : ""), en: account.displayName + " · " + account.email + (account.disabled ? " (" + copy.disabled.en + ")" : "") } }))];
  const selector = select(choices, selectedAccountId); const editor = el("div");
  section.append(field("account", selector), editor);
  async function chooseAccount() {
    const next = selector.value;
    if (hasDirty(editor) && !await confirmDialog("discardTitle", translated("discardHelp"), "discard", "keepDraft")) { selector.value = selectedAccountId; return; }
    selectedAccountId = next; accountDraft = null; editor.replaceChildren();
    const account = state.accounts.find(item => item.id === next);
    if (account) editor.append(accountForm(account));
  }
  selector.addEventListener("change", () => chooseAccount().catch(showError));
  const initial = state.accounts.find(item => item.id === selectedAccountId);
  if (initial) editor.append(accountForm(initial));
}
function accountForm(account) {
  const { form, message } = formWithStatus();
  accountDraft = model.clone(account);
  let baseline = { clearance: account.clearance, grants: model.clone(account.grants) };
  const level = levels(account.clearance); level.addEventListener("change", () => { accountDraft.clearance = level.value === "" ? null : Number(level.value); });
  form.append(el("p", {}, pair("role"), ": ", pair(account.role)), field("clearance", level));
  if (account.disabled) form.append(pair("disabled", "p"));
  const list = el("div"), empty = pair("noGrants", "p");
  const syncEmpty = () => { empty.hidden = accountDraft.grants.length !== 0; };
  function appendGrant(grant) { list.append(grantCard(grant, form, () => { syncEmpty(); })); }
  for (const grant of accountDraft.grants) appendGrant(grant);
  syncEmpty(); form.append(heading("grants", "h3"), empty, list, button("addGrant", () => {
    const grant = { id: uid(), orgId: state.me.orgId, enterpriseKey: "", categoryIds: [], ownership: "", dimensions: {} };
    accountDraft.grants.push(grant); appendGrant(grant); syncEmpty(); dirty(form); updateButtons();
  }, "secondary", true));
  onSubmit(form, message, async () => {
    if (level.value === "") { status(message, "required", true); return; }
    const invalid = accountDraft.grants.map(validateGrant).find(Boolean);
    if (invalid) { status(message, invalid, true); return; }
    const after = { clearance: Number(level.value), grants: model.clone(accountDraft.grants) };
    const beforeAccount = { ...account, ...baseline }, afterAccount = { ...account, ...after };
    await saveChange(form, message, "/accounts/" + encodeURIComponent(account.id), "PATCH", baseline, after, summaryPair(account.displayName, { zh: accountSummary(beforeAccount, "zh"), en: accountSummary(beforeAccount, "en") }, { zh: accountSummary(afterAccount, "zh"), en: accountSummary(afterAccount, "en") }), () => { baseline = model.clone(after); Object.assign(account, after); accountDraft = { ...model.clone(account), ...model.clone(after) }; });
  });
  return form;
}
function validateSelection(selection) { return selection && (selection.kind === "all" || selection.kind === "fixed" && Array.isArray(selection.values) && selection.values.length > 0); }
function validateGrant(grant) {
  if (!grant.enterpriseKey || !["store", "group"].includes(grant.ownership) || !grant.categoryIds.length) return "invalidGrant";
  if (grant.ownership === "store" && !validateSelection(grant.stores)) return "invalidGrant";
  if (grant.ownership === "store" && grant.stores.kind === "fixed" && grant.stores.values.some(name => !state.stores.some(store => store.enterpriseKey === grant.enterpriseKey && store.name === name))) return "invalidGrant";
  const requiredSets = [];
  for (const id of grant.categoryIds) {
    const category = state.categories.find(item => item.id === id);
    if (!category || !(grant.ownership === "store" ? category.allowStore : category.allowGroup)) return "invalidGrant";
    const required = category.dimensions.map(item => item.dimensionId).sort(); requiredSets.push(required.join("|"));
    if (Object.keys(grant.dimensions).length !== required.length || required.some(dimensionId => !validateSelection(grant.dimensions[dimensionId]))) return "invalidGrant";
  }
  if (new Set(requiredSets).size > 1) return "differentConditions";
  return null;
}
function grantCard(original, form, removed) {
  let grant = model.clone(original);
  const card = el("div", { class: "subpanel" });
  function update(patch) { grant = { ...grant, ...patch }; accountDraft.grants = model.replaceGrant(accountDraft.grants, grant.id, grant); dirty(form); }
  async function remove() {
    if (!await confirmDialog("removeGrant", { zh: grantDescription(grant, "zh"), en: grantDescription(grant, "en") }, "removeGrant")) return false;
    accountDraft.grants = model.removeGrant(accountDraft.grants, grant.id); card.remove(); dirty(form); removed(); return true;
  }
  const enterprise = enterpriseSelect(grant.enterpriseKey);
  const ownership = select([blank(), { value: "store", label: translated("store") }, { value: "group", label: translated("group") }], grant.ownership);
  const categoriesArea = el("div"), storesArea = el("div"), dimensionsArea = el("div");
  enterprise.addEventListener("change", () => { update({ enterpriseKey: enterprise.value, ...(grant.ownership === "store" ? { stores: { kind: "fixed", values: [] } } : {}) }); renderStoresSelection(); });
  ownership.addEventListener("change", () => {
    const next = { ...grant, ownership: ownership.value };
    if (ownership.value === "store" && !next.stores) next.stores = { kind: "fixed", values: [] };
    if (ownership.value !== "store") delete next.stores;
    grant = next; accountDraft.grants = model.replaceGrant(accountDraft.grants, grant.id, grant); dirty(form);
    renderCategoriesSelection(); renderStoresSelection(); renderGrantDimensions();
  });
  function renderCategoriesSelection() {
    const internalIds = grant.categoryIds.filter(id => state.categories.some(category => category.id === id && category.key === "delivery_ledger"));
    const choices = state.categories.filter(category => category.key !== "delivery_ledger" && (!grant.ownership || (grant.ownership === "store" ? category.allowStore : category.allowGroup) || grant.categoryIds.includes(category.id))).map(category => ({ value: category.id, label: categoryLabel(category), disabled: category.retired }));
    for (const id of grant.categoryIds) if (!internalIds.includes(id) && !choices.some(choice => choice.value === id)) choices.push({ value: id, label: translated("preserved") });
    const selection = checklist("categoriesLabel", choices, grant.categoryIds, values => { update({ categoryIds: [...internalIds, ...values] }); renderGrantDimensions(); });
    categoriesArea.replaceChildren(selection.node);
    if (internalIds.length) categoriesArea.append(pair("internalLedger", "p"));
  }
  function renderStoresSelection() {
    storesArea.replaceChildren();
    if (grant.ownership !== "store") { if (grant.ownership === "group") storesArea.append(pair("groupHelp", "p")); return; }
    const mode = select([blank(), { value: "none", label: translated("noStoreRead") }, { value: "fixed", label: translated("selectedStores") }, { value: "all", label: translated("allStores") }], grant.stores && grant.stores.kind || "");
    const valuesArea = el("div"); storesArea.append(field("stores", mode), valuesArea);
    function renderValues() {
      valuesArea.replaceChildren();
      if (!grant.stores || grant.stores.kind !== "fixed") return;
      const options = state.stores.filter(store => store.enterpriseKey === grant.enterpriseKey).map(store => ({ value: store.name, label: itemLabel(store), disabled: store.retired }));
      for (const name of grant.stores.values) if (!options.some(choice => choice.value === name)) options.push({ value: name, label: name });
      const selection = checklist("selectedStores", options, grant.stores.values, values => update({ stores: { kind: "fixed", values } })); valuesArea.append(selection.node);
    }
    mode.addEventListener("change", async () => {
      if (mode.value === "none") { const previous = grant.stores && grant.stores.kind || ""; if (!await remove()) mode.value = previous; return; }
      update({ stores: mode.value === "all" ? { kind: "all" } : { kind: "fixed", values: grant.stores && grant.stores.kind === "fixed" ? grant.stores.values : [] } }); renderValues();
    });
    renderValues();
  }
  function renderGrantDimensions() {
    dimensionsArea.replaceChildren();
    const required = new Set(grant.categoryIds.flatMap(id => { const category = state.categories.find(item => item.id === id); return category ? category.dimensions.map(item => item.dimensionId) : []; }));
    const ids = new Set([...required, ...Object.keys(grant.dimensions)]);
    for (const id of ids) {
      const dimension = state.dimensions.find(item => item.id === id);
      const selection = grant.dimensions[id];
      const container = el("div", { class: "subpanel" });
      const mode = select([blank(), { value: "fixed", label: translated("selectedValues") }, { value: "all", label: translated("allValues") }], selection && selection.kind || "");
      const valuesArea = el("div");
      container.append(field(dimension ? { zh: dimension.name, en: dimension.name } : translated("preserved"), mode), valuesArea);
      function setSelection(value) { const dimensions = model.clone(grant.dimensions); if (value === undefined) delete dimensions[id]; else dimensions[id] = value; update({ dimensions }); }
      function renderValues() {
        valuesArea.replaceChildren(); const current = grant.dimensions[id];
        if (!current || current.kind !== "fixed") return;
        const choices = (dimension ? dimension.values : []).map(value => ({ value: value.id, label: itemLabel(value), disabled: value.retired }));
        for (const value of current.values) if (!choices.some(choice => choice.value === value)) choices.push({ value, label: translated("preserved") });
        const chosen = checklist("selectedValues", choices, current.values, values => setSelection({ kind: "fixed", values })); valuesArea.append(chosen.node);
      }
      mode.addEventListener("change", () => { const current = grant.dimensions[id]; setSelection(mode.value === "all" ? { kind: "all" } : mode.value === "fixed" ? { kind: "fixed", values: current && current.kind === "fixed" ? current.values : [] } : undefined); renderValues(); });
      if (!required.has(id)) container.append(button("removeCondition", () => { setSelection(undefined); renderGrantDimensions(); }, "secondary", true));
      renderValues(); dimensionsArea.append(container);
    }
  }
  card.append(el("div", { class: "row" }, field("enterprise", enterprise), field("ownership", ownership)), categoriesArea, storesArea, dimensionsArea, button("removeGrant", remove, "secondary", true));
  renderCategoriesSelection(); renderStoresSelection(); renderGrantDimensions(); return card;
}`;
