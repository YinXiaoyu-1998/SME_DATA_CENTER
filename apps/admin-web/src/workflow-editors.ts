/** Form builders use exact names/identities and update only their in-memory draft. */
export const workflowEditorsSource = String.raw`
 function editableList(parent, key, items, make, edit, maximum = 2000) {
  const area = el("div");
  const draw = () => {
   area.replaceChildren();
   items.forEach((item, index) => {
    const row = el("div", { class: "subpanel" }); edit(row, item);
    row.append(button("remove", () => { items.splice(index, 1); dirty = true; draw(); }, true)); area.append(row);
   });
   const add = button("add", () => { if (items.length >= maximum) throw { uiKey: "invalid" }; items.push(make()); dirty = true; draw(); }, true); add.disabled = items.length >= maximum; area.append(add); updateButtons();
  };
  parent.append(heading(key, "h3"), area); draw();
 }
 function sourceFields(parent, source, reviewsOnly = false) {
  const product = select((reviewsOnly ? ["meituan_reviews"] : ["meituan_erp", "meituan_reviews"]).map(value => ({ value })), source.product, value => { source.product = value; source.channel = value === "meituan_erp" ? "erp" : "meituan"; sourceArea(); });
  const account = select([{ value: "", label: config.copy.choose }, ...controller.state.integration.sourceAccounts.map(a => ({ value: a.accountRef, label: { zh: a.displayName, en: a.displayName }, product: a.product })).filter(a => a.product === source.product || !a.product)], source.accountRef, value => { source.accountRef = value; });
  // Preserve a declared identity even while its account is temporarily unavailable in this panel.
  if (source.accountRef && ![...account.options].some(o => o.value === source.accountRef)) account.append(el("option", { value: source.accountRef }, source.accountRef));
  account.value = source.accountRef;
  const dynamic = el("div");
  function sourceArea() {
   dynamic.replaceChildren(field("channel", select((source.product === "meituan_erp" ? ["erp"] : ["meituan", "dianping"]).map(value => ({ value })), source.channel, value => { source.channel = value; })));
   account.replaceChildren(el("option", { value: "", "data-option-zh": config.copy.choose.zh, "data-option-en": config.copy.choose.en }, text("choose")));
   for (const a of controller.state.integration.sourceAccounts.filter(a => a.product === source.product)) account.append(el("option", { value: a.accountRef }, a.displayName));
   if (source.accountRef && ![...account.options].some(o => o.value === source.accountRef)) account.append(el("option", { value: source.accountRef }, source.accountRef));
   account.value = source.accountRef;
  }
  parent.append(el("div", { class: "row" }, field("product", product), field("sourceAccounts", account)), dynamic,
   field("sourceStoreName", input(source.sourceStoreName, value => { source.sourceStoreName = value; })),
   field("sourceStoreId", input(source.sourceStoreId, value => { if (value) source.sourceStoreId = value; else delete source.sourceStoreId; })));
  sourceArea();
 }
 const newSource = (reviews = false) => ({ product: reviews ? "meituan_reviews" : "meituan_erp", channel: reviews ? "meituan" : "erp", accountRef: "", sourceStoreName: "" });
 function renderIntegration(parent, draft) {
  parent.append(pair("sourceHelp", "p"), pair("sourceAccountHelp", "p"));
  editableList(parent, "sourceAccounts", draft.sourceAccounts, () => ({ product: "meituan_erp", accountRef: "", displayName: "", sourceEnterpriseName: "" }), (row, account) => {
   row.append(field("product", select(["meituan_erp", "meituan_reviews"].map(value => ({ value })), account.product, value => { account.product = value; })));
   for (const key of ["accountRef", "displayName", "sourceEnterpriseName", "sourceGroupName"]) row.append(field(key, input(account[key], value => { if (key === "sourceGroupName" && !value) delete account[key]; else account[key] = value; })));
  }, 100);
  editableList(parent, "storeMappings", draft.storeMappings, () => ({ source: newSource(), storeName: "" }), (row, item) => {
   sourceFields(row, item.source);
   row.append(field("storeName", select([{ value: "", label: config.copy.choose }, ...storeChoices([item.storeName].filter(Boolean))], item.storeName, value => { item.storeName = value; })));
  });
  editableList(parent, "exclusions", draft.exclusions, () => ({ source: newSource(), reason: "" }), (row, item) => { sourceFields(row, item.source); row.append(field("reason", input(item.reason, value => { item.reason = value; }, 2000, true))); });
  parent.append(button("saveIntegration", () => commit({ kind: "integration", configuration: draft }), true));
 }
 function mailFields(parent, key, mail) {
  parent.append(heading(key, "h3"), check("mailEnabled", mail.enabled, value => { mail.enabled = value; }), field("recipients", input(mail.recipients.join("\n"), value => { mail.recipients = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }, 5100, true)), field("allowedSender", input(mail.allowedSender, value => { if (value.trim()) mail.allowedSender = value.trim(); else delete mail.allowedSender; }, 254)));
 }
 function renderConfiguration(parent, draft) {
  parent.append(heading("configuration"));
  if (!stores.length) parent.append(pair("noStores", "p"));
  parent.append(checklist("stores", storeChoices(draft.storeNames), draft.storeNames, value => { draft.storeNames = value; }));
  if (draft.type === "meituan-daily-ingestion") {
   parent.append(checklist("datasets", ["business", "dishes", "in_store_orders", "takeaway_orders", "delivery_ledger"], draft.datasets, value => { draft.datasets = value; }), pair("orderScope", "p"), pair("cleanupIngestion", "p"));
  } else if (draft.type === "meituan-review-operations") {
   parent.append(checklist("channels", ["meituan", "dianping"], draft.channels, value => { draft.channels = value; }), check("publicationEnabled", draft.publication.enabled, value => { draft.publication.enabled = value; }), checklist("publicationStores", storeChoices(draft.publication.storeNames), draft.publication.storeNames, value => { draft.publication.storeNames = value; }), field("brandFacts", input(draft.brandFacts, value => { draft.brandFacts = value; }, 20000, true)), field("tone", input(draft.tone, value => { draft.tone = value; }, 2000, true)), pair("textHelp", "p"), pair("policy", "p"), pair("ignoredHelp", "p"));
   draft.ignoredReviewIdentities ||= [];
   editableList(parent, "ignoredReviewIdentities", draft.ignoredReviewIdentities, () => ({ source: newSource(true), feedbackId: "", reason: "", purpose: "exclude_source_record" }), (row, item) => { sourceFields(row, item.source, true); row.append(field("feedbackId", input(item.feedbackId, value => { item.feedbackId = value; })), field("reason", input(item.reason, value => { item.reason = value; }, 2000, true))); });
   mailFields(parent, "draftNotification", draft.draftNotification);
  } else {
   parent.append(pair("ungrouped", "p"));
   editableList(parent, "groups", draft.groups, () => ({ name: "", storeNames: [] }), (row, group) => { row.append(field("groupName", input(group.name, value => { group.name = value; })), checklist("stores", storeChoices(group.storeNames), group.storeNames, value => { group.storeNames = value; })); }, 100);
   mailFields(parent, "delivery", draft.delivery); parent.append(pair("localReport", "p"));
  }
  parent.append(button("saveConfiguration", () => { const error = workflowModel.validate(draft); if (error) throw { uiKey: error }; return commit({ kind: "configuration", configuration: draft }); }, true));
 }
 function renderAuthorizations(parent, view, draft) {
  parent.append(heading("authorizations"), pair("authorizationHelp", "p"));
  const type = controller.state.selected;
  const revoke = controller.state.revocations[type] ||= new Set();
  for (const grant of view?.authorizations || []) {
   const chosen = el("input", { type: "checkbox", checked: revoke.has(grant.authorizationId) }); chosen.addEventListener("change", () => { if (chosen.checked) revoke.add(grant.authorizationId); else revoke.delete(grant.authorizationId); dirty = true; });
   parent.append(el("div", { class: "subpanel" }, el("label", { class: "check" }, chosen, pair("revokeSelection"), " · ", pair(grant.scope.kind)), summary(grant.scope)));
  }
  if (!view?.authorizations?.length) parent.append(pair("empty", "p"));
  parent.append(button("revoke", () => { if (!revoke.size) throw { uiKey: "invalid" }; return commit({ kind: "authorization", grant: [], revokeAuthorizationIds: [...revoke] }); }, true));
  if (!view?.configuration) { parent.append(pair("configurationRequired", "p")); return; }
  const allowedActions = draft.type === "meituan-daily-ingestion" ? ["upload"] : draft.type === "meituan-review-operations" ? ["review_sync", "review_publish", "email"] : ["download", "email"];
  const auth = controller.state.authorizationDrafts[type] ||= { kind: allowedActions[0], storeNames: [], datasets: [], channels: [], purpose: draft.type === "meituan-review-operations" ? "review_drafts" : "weekly_report", recipients: [], allowedSender: "", deliveryVersion: 1 };
  const detail = el("div");
  const draw = () => {
   detail.replaceChildren(checklist("stores", storeChoices(view.configuration.storeNames).filter(s => view.configuration.storeNames.includes(s.value)), auth.storeNames, value => { auth.storeNames = value; }));
   if (auth.kind === "upload" || auth.kind === "download") detail.append(checklist("datasets", ["business", "dishes", "in_store_orders", "takeaway_orders", ...(auth.kind === "upload" ? ["delivery_ledger"] : [])], auth.datasets, value => { auth.datasets = value; }));
   if (auth.kind === "review_sync" || auth.kind === "review_publish") detail.append(checklist("channels", ["meituan", "dianping"], auth.channels, value => { auth.channels = value; }));
   if (auth.kind === "email") detail.append(field("purpose", select(["review_drafts", "weekly_report", "exception"].map(value => ({ value })), auth.purpose, value => { auth.purpose = value; })), field("recipients", input(auth.recipients.join("\n"), value => { auth.recipients = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }, 5100, true)), field("allowedSender", input(auth.allowedSender, value => { auth.allowedSender = value.trim(); }, 254)), field("deliveryVersion", input(auth.deliveryVersion, value => { auth.deliveryVersion = Number(value); }, 10)));
  };
  parent.append(field("action", select(allowedActions.map(value => ({ value })), auth.kind, value => { auth.kind = value; draw(); })), detail, button("previewGrant", () => {
   const { kind, storeNames, datasets, channels, purpose, recipients, allowedSender, deliveryVersion } = auth;
   if (!storeNames.length || ((kind === "upload" || kind === "download") && !datasets.length) || ((kind === "review_sync" || kind === "review_publish") && !channels.length)) throw { uiKey: "invalid" };
   const scope = { kind, storeNames, ...((kind === "upload" || kind === "download") ? { datasets } : (kind === "review_sync" || kind === "review_publish") ? { channels } : { purpose, recipients, allowedSender, deliveryVersion }) };
   return commit({ kind: "authorization", grant: [scope], revokeAuthorizationIds: [] });
  }, true)); draw();
 }

 function renderControl(parent, view) {
  parent.append(heading("control"), pair(view?.controlState || "notConfigured", "p"), pair("activateHelp", "p"));
  const type = controller.state.selected;
  let reason = controller.state.controlReasons[type] || ""; parent.append(field("reason", input(reason, value => { reason = value; controller.state.controlReasons[type] = value; }, 2000, true)));
  for (const [key, state] of [["activate", "active"], ["pause", "paused"], ["revokeControl", "revoked"]]) parent.append(button(key, () => { if (!reason.trim()) throw { uiKey: "invalid" }; return commit({ kind: "control", state, reason }); }, true, state === "revoked" ? "danger" : "secondary"));
 }
`;
