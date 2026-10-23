/** Browser actions, shared verbatim with lightweight HTTP-boundary behavior tests. */
export const ledgerControllerSource = String.raw`
function createLedgerController({ request, limits, changed, newKey, schedule, cancel, release, save }) {
  const model = createLedgerModel(limits);
  const state = { identity: null, csrfToken: null, authenticated: false, recovering: false, error: null, rows: [], stores: new Set(), scope: null, cursors: [null], batch: 0, nextCursor: null, querying: false, queryError: null, preview: null, downloads: new Set(), notices: new Map(), tasks: [], submitting: false, submitError: null };
  let attempt = null;
  let epoch = 0, queryVersion = 0, previewVersion = 0, recovery = null;
  const timers = new Map();
  const identityKey = identity => identity ? JSON.stringify([identity.orgId, identity.employeeId]) : null;
  const failCode = error => error && error.code || "NETWORK_ERROR";
  const notify = () => changed();
  const stopTimers = () => { for (const timer of timers.values()) cancel(timer); timers.clear(); };
  function clearPreview() { previewVersion++; if (state.preview?.url) release(state.preview.url); state.preview = null; }
  function expire() {
    epoch++; queryVersion++; clearPreview(); stopTimers(); state.authenticated = false; state.csrfToken = null; state.querying = false; state.submitting = false; state.downloads.clear(); state.error = "BROWSER_SIGN_IN_REQUIRED"; notify();
  }
  async function call(path, body) {
    const session = epoch;
    try { return await request(path, body, state.csrfToken); }
    catch (error) { if (session === epoch && (error?.code === "BROWSER_SIGN_IN_REQUIRED" || error?.code === "BROWSER_SECURITY_CHECK_FAILED")) expire(); throw error; }
  }
  async function revalidate(version) {
    const all = model.selection(), results = [];
    model.reconcile([]);
    // Oversized selections remain intact; validate bounded chunks without dropping any key.
    for (let i = 0; i < all.length;) {
      const batch = [], stores = new Set(), dates = new Set();
      while (i < all.length && batch.length < limits.pageSize) {
        const item = all[i];
        if (batch.length && ((!stores.has(item.storeName) && stores.size >= limits.stores) || (!dates.has(item.purchaseDate) && dates.size >= limits.dates))) break;
        batch.push(item); stores.add(item.storeName); dates.add(item.purchaseDate); i++;
      }
      let cursor = null;
      do {
        if (version !== epoch) return;
        const response = await call("coverage", { selection: batch, ...(cursor ? { cursor } : {}) });
        if (version !== epoch) return;
        results.push(...response.partitions); cursor = response.nextCursor;
      } while (cursor);
    }
    model.reconcile(results);
  }
  async function resume() {
    if (recovery) return recovery;
    recovery = (async () => {
      const version = ++epoch;
      queryVersion++; state.querying = false; state.submitting = false; state.downloads.clear();
      for (const task of state.tasks) { task.waiting = false; task.linking = false; }
      state.recovering = true; state.authenticated = false; state.error = null; stopTimers(); clearPreview(); notify();
      try {
        const context = await request("context");
        if (version !== epoch) return;
        if (identityKey(state.identity) !== identityKey(context.identity)) {
          model.clear(); state.rows = []; state.stores.clear(); state.cursors = [null]; state.batch = 0; state.nextCursor = null; state.tasks = []; state.activeTask = null; attempt = null; state.scope = null; state.notices.clear(); state.submitError = null;
        }
        state.identity = context.identity; state.csrfToken = context.csrfToken;
        await revalidate(version);
        if (version !== epoch) return;
        state.authenticated = true;
        for (const task of state.tasks) if (["queued", "running"].includes(task.status)) queuePoll(task);
      } catch (error) { if (version === epoch) state.error = failCode(error); }
      finally { state.recovering = false; recovery = null; notify(); }
    })();
    return recovery;
  }
  async function query(scope, batch = 0) {
    if (!state.authenticated || state.recovering) return;
    const version = ++queryVersion, session = epoch;
    state.querying = true; state.queryError = null; notify();
    try {
      const response = await call("coverage", { scope, ...(batch && state.cursors[batch] ? { cursor: state.cursors[batch] } : {}) });
      if (version !== queryVersion || session !== epoch) return;
      state.scope = scope; state.batch = batch; if (!batch) state.cursors = [null];
      state.rows = response.partitions; state.nextCursor = response.nextCursor;
      state.cursors[batch + 1] = response.nextCursor;
      for (const item of state.rows) { state.stores.add(item.storeName); if (model.selected.has(ledgerKey(item))) model.selected.set(ledgerKey(item), { ...item }); }
    } catch (error) { if (version === queryVersion && session === epoch) state.queryError = failCode(error); }
    finally { if (version === queryVersion) state.querying = false; notify(); }
  }
  async function preview(item) {
    if (!state.authenticated || state.recovering) return;
    clearPreview(); const version = previewVersion, session = epoch;
    state.preview = { item, waiting: true, url: null, error: null }; notify();
    try {
      const result = await call("pdf?" + new URLSearchParams({ storeName: item.storeName, purchaseDate: item.purchaseDate, disposition: "inline" }));
      if (version !== previewVersion || session !== epoch) { release(result.url); return; }
      state.preview.url = result.url;
    } catch (error) { if (version === previewVersion && session === epoch) state.preview.error = failCode(error); }
    finally { if (version === previewVersion && state.preview) state.preview.waiting = false; notify(); }
  }
  async function download(item) {
    const key = ledgerKey(item);
    if (!state.authenticated || state.recovering || state.downloads.has(key)) return;
    const session = epoch; state.downloads.add(key); state.notices.delete(key); notify();
    try {
      const result = await call("pdf?" + new URLSearchParams({ storeName: item.storeName, purchaseDate: item.purchaseDate, disposition: "attachment" }));
      if (session !== epoch) { release(result.url); return; }
      save(result.url, result.fileName); state.notices.set(key, "downloadStarted");
    } catch (error) { if (session === epoch) state.notices.set(key, failCode(error)); }
    finally { if (session === epoch) state.downloads.delete(key); notify(); }
  }
  const pending = task => ["queued", "running"].includes(task.status);
  function queuePoll(task) {
    if (timers.has(task)) cancel(timers.get(task));
    if (state.authenticated && pending(task)) timers.set(task, schedule(() => { timers.delete(task); void poll(task); }, 2500));
  }
  async function poll(task) {
    if (!state.authenticated || state.recovering || task.waiting || !pending(task)) return;
    if (timers.has(task)) { cancel(timers.get(task)); timers.delete(task); }
    const session = epoch; task.waiting = true; task.error = null; notify();
    try {
      const result = await call("requests/" + encodeURIComponent(task.requestId));
      if (session !== epoch) return;
      task.status = result.status; task.error = result.errorCode || null;
      if (pending(task)) queuePoll(task);
    } catch (error) { if (session === epoch) task.error = failCode(error); }
    finally { if (session === epoch) task.waiting = false; notify(); }
  }
  async function submit(fresh = false) {
    if (!state.authenticated || state.recovering || state.submitting || !model.summary().allowed) return;
    const selection = model.selection(), fingerprint = JSON.stringify(selection);
    if (fresh || !attempt || attempt.fingerprint !== fingerprint) attempt = { fingerprint, selection, idempotencyKey: newKey(), task: null };
    if (attempt.task) { state.activeTask = attempt.task; notify(); return; }
    const submitted = attempt, session = epoch;
    state.submitting = true; state.activeTask = null; state.submitError = null; notify();
    try {
      const result = await call("downloads", { selection: submitted.selection, idempotencyKey: submitted.idempotencyKey });
      if (session !== epoch) return;
      const task = { ...result, selection: submitted.selection, waiting: false, linking: false, error: null, notice: null };
      submitted.task = task; state.tasks.unshift(task); state.activeTask = task; queuePoll(task);
    } catch (error) { if (session === epoch) state.submitError = failCode(error); }
    finally { if (session === epoch) state.submitting = false; notify(); }
  }
  async function link(task) {
    if (!state.authenticated || state.recovering || task.linking || task.status !== "succeeded") return;
    const session = epoch; task.linking = true; task.error = null; notify();
    try {
      const result = await call("requests/" + encodeURIComponent(task.requestId) + "/download-url", null);
      if (session !== epoch) return;
      save(result.downloadUrl, ""); task.notice = "downloadStarted"; task.expiresAt = result.expiresAt;
    } catch (error) { if (session === epoch) task.error = failCode(error); }
    finally { if (session === epoch) task.linking = false; notify(); }
  }
  return { model, state, expire, resume, notify, query, preview, download, submit, poll, link, closePreview() { clearPreview(); notify(); } };
}`;
