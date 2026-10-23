import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { ledgerModelSource } from "./ledger-model.js";
const limits = { files: 5000, stores: 50, dates: 366, bytes: 1073741824, pageSize: 200 };
const item = { storeName: " Store ", purchaseDate: "2026-10-01", status: "ready", byteSize: 25 };
// The shipped controller's public browser actions; HTTP is the external boundary.
async function client(request: (path: string, body?: unknown) => Promise<unknown>) {
  const module = await import("./ledger-controller.js").catch(() => null);
  expect(module).not.toBeNull();
  const schedule = vi.fn();
  const c = runInNewContext(
    `${ledgerModelSource}\n${module!.ledgerControllerSource}; createLedgerController(options);`,
    {
      URLSearchParams,
      options: {
        request,
        limits,
        changed() {},
        newKey: () => "synthetic-key",
        schedule,
        cancel() {},
        release() {},
        save() {}
      }
    }
  );
  return { c, schedule };
}
it("refreshes context and CSRF before revalidating all selections and clears another account's data", async () => {
  let context = { identity: { orgId: "org", employeeId: "one" }, csrfToken: "new-token" };
  const request = vi.fn(async (path: string) =>
    path === "context" ? context : { partitions: [], nextCursor: null }
  );
  const { c } = await client(request);
  await c.resume();
  c.model.select(item, true);
  c.expire();
  expect(c.model.selection()).toHaveLength(1);
  expect(c.state.authenticated).toBe(false);
  await c.resume();
  expect(c.state.csrfToken).toBe("new-token");
  expect(c.model.selection()).toHaveLength(1);
  expect(c.model.summary().allowed).toBe(false);
  expect(request).toHaveBeenCalledWith(
    "coverage",
    { selection: [{ storeName: " Store ", purchaseDate: "2026-10-01" }] },
    "new-token"
  );
  context = { identity: { orgId: "org", employeeId: "two" }, csrfToken: "other-token" };
  await c.resume();
  expect(c.model.selection()).toHaveLength(0);
  expect(c.state.rows).toEqual([]);
});
it("keeps cross-query selection and ignores older preview responses while downloads wait independently", async () => {
  let finishOld!: (value: unknown) => void;
  const request = async (path: string) => {
    if (path === "context")
      return { identity: { orgId: "org", employeeId: "one" }, csrfToken: "csrf" };
    if (path.startsWith("pdf?") && path.includes("Old"))
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    if (path.startsWith("pdf?")) return { url: "blob:new", fileName: "new.pdf" };
    return { partitions: [item], nextCursor: "page-2" };
  };
  const { c } = await client(request);
  await c.resume();
  await c.query({ startDate: "2026-10-01", endDate: "2026-10-02" });
  c.model.select(item, true);
  await c.query({ storeNames: ["Other"], dates: ["2026-10-01"] });
  expect(c.model.selection()).toHaveLength(1);
  const old = c.preview({ ...item, storeName: "Old" });
  expect(c.state.preview.waiting).toBe(true);
  expect(c.state.querying).toBe(false);
  await c.preview(item);
  finishOld({ url: "blob:old", fileName: "old.pdf" });
  await old;
  expect(c.state.preview.url).toBe("blob:new");
  expect(c.state.preview.item.storeName).toBe(" Store ");
});
it("retries a failed submission with the same key, pins its list and stops polling on a terminal result", async () => {
  let failures = 1;
  const bodies: unknown[] = [];
  const request = async (path: string, body?: unknown) => {
    if (path === "context")
      return { identity: { orgId: "org", employeeId: "one" }, csrfToken: "csrf" };
    if (path === "downloads") {
      bodies.push(body);
      if (failures--) throw new Error("offline");
      return { requestId: "task", status: "queued" };
    }
    return { requestId: "task", status: "succeeded", partitions: [item], nextCursor: null };
  };
  const { c, schedule } = await client(request);
  await c.resume();
  c.model.select(item, true);
  await c.submit();
  expect(c.state.submitError).toBe("NETWORK_ERROR");
  await c.submit();
  expect(bodies[0]).toEqual(bodies[1]);
  c.model.select({ ...item, storeName: "later" }, true);
  expect(c.state.tasks[0].selection).toEqual([
    { storeName: " Store ", purchaseDate: "2026-10-01" }
  ]);
  await c.poll(c.state.tasks[0]);
  expect(c.state.tasks[0].status).toBe("succeeded");
  const calls = schedule.mock.calls.length;
  await c.poll(c.state.tasks[0]);
  expect(schedule.mock.calls.length).toBe(calls);
});
it("waits for only the requested single download and reports initiation without claiming browser completion", async () => {
  let finish!: (value: unknown) => void;
  const request = async (path: string) =>
    path === "context"
      ? { identity: { orgId: "org", employeeId: "one" }, csrfToken: "csrf" }
      : new Promise((resolve) => {
          finish = resolve;
        });
  const { c } = await client(request);
  await c.resume();
  const download = c.download(item);
  expect(c.state.downloads.size).toBe(1);
  expect(c.state.querying).toBe(false);
  expect(c.state.submitting).toBe(false);
  finish({ url: "blob:single", fileName: "single.pdf" });
  await download;
  expect(c.state.downloads.size).toBe(0);
  expect([...c.state.notices.values()]).toEqual(["downloadStarted"]);
});
it("unlocks a submission interrupted by expiry without discarding its idempotent retry", async () => {
  let resolvePost!: (value: unknown) => void;
  const submitted: unknown[] = [];
  let counter = 0;
  const request = async (path: string, body?: unknown) => {
    if (path === "context")
      return { identity: { orgId: "org", employeeId: "one" }, csrfToken: "csrf" };
    if (path === "coverage") return { partitions: [item], nextCursor: null };
    if (path === "downloads") {
      submitted.push(body);
      if (!counter++)
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      return { requestId: "task", status: "queued" };
    }
    throw new Error("unexpected");
  };
  const { c } = await client(request);
  await c.resume();
  c.model.select(item, true);
  const pending = c.submit();
  await c.resume();
  expect(c.state.submitting).toBe(false);
  await c.submit();
  resolvePost({ requestId: "task", status: "queued" });
  await pending;
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toEqual(submitted[1]);
  expect(c.state.tasks).toHaveLength(1);
});
