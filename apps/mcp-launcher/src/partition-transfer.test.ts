import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPartitionDataset, uploadPartitionDataset } from "./partition-transfer.js";

describe("launcher partition transfer", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("streams a path upload through bounded multipart URLs and returns only the job", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const source = path.join(root, "source.csv");
    await writeFile(source, Buffer.alloc(20, 7));
    const partOne = path.join(root, "one.part");
    const partTwo = path.join(root, "two.part");
    const fetchImplementation = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/v1/structured/partition-uploads"))
          return Response.json(
            {
              partitionImportJobId: "pjob_1",
              status: "uploading",
              partSize: 16,
              totalParts: 2,
              expiresAt: new Date().toISOString(),
              parts: [
                { partNumber: 1, uploadUrl: pathToFileURL(partOne).href },
                { partNumber: 2, uploadUrl: pathToFileURL(partTwo).href }
              ],
              nextAfterPartNumber: null
            },
            { status: 201 }
          );
        if (url.endsWith("/complete"))
          return Response.json({
            partitionImportJobId: "pjob_1",
            status: "queued",
            partitionCount: 0,
            totalRowCount: 0
          });
        throw new Error(`Unexpected request ${url} ${init?.method}`);
      }
    ) as unknown as typeof fetch;
    const result = await uploadPartitionDataset({
      context: context(fetchImplementation),
      filePath: source,
      name: "source.csv",
      mediaType: "text/csv",
      dataset: "business",
      enterpriseName: "Synthetic",
      startDate: "20260907",
      endDate: "20260913",
      idempotencyKey: "idem"
    });
    expect(result).toMatchObject({ partitionImportJobId: "pjob_1", status: "queued" });
    await expect(readFile(partOne)).resolves.toHaveLength(16);
    await expect(readFile(partTwo)).resolves.toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("uploadUrl");
  });

  it("allows a progressing multipart upload beyond the download-only 240 second budget", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const source = path.join(root, "source.csv");
    await writeFile(source, Buffer.alloc(13, 7));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const began = Date.now();
    let part = 0;
    const remote = vi.fn<typeof fetch>(async (request, init) => {
      if (init?.method === "PUT") {
        for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) {
          expect(chunk).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(20_000);
        }
        return new Response(null, { headers: { etag: `part-${part}` } });
      }
      if (String(request).endsWith("/complete")) return Response.json({ status: "queued" });
      part++;
      return Response.json({
        partitionImportJobId: "progress",
        status: "uploading",
        partSize: 1,
        parts: [{ partNumber: part, uploadUrl: "https://storage.example/part" }],
        nextAfterPartNumber: part === 13 ? null : part
      });
    });
    try {
      expect(
        await uploadPartitionDataset({
          context: context(remote),
          filePath: source,
          name: "source.csv",
          mediaType: "text/csv",
          dataset: "business",
          enterpriseName: "Synthetic",
          startDate: "20261001",
          endDate: "20261002",
          idempotencyKey: "progress"
        })
      ).toMatchObject({ status: "queued" });
      expect(Date.now() - began).toBeGreaterThan(240_000);
      expect(remote.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a fresh bounded cleanup signal after caller cancellation", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const source = path.join(root, "source.csv");
    await writeFile(source, "x");
    const caller = new AbortController();
    let cleanupSignal: AbortSignal | null | undefined;
    const remote = vi.fn<typeof fetch>(async (_request, init) => {
      if (init?.method === "PUT") {
        caller.abort(new Error("cancelled"));
        throw caller.signal.reason;
      }
      if (init?.method === "DELETE") {
        cleanupSignal = init.signal;
        return Response.json({});
      }
      return Response.json({
        partitionImportJobId: "cancel",
        status: "uploading",
        partSize: 1,
        parts: [{ partNumber: 1, uploadUrl: "https://storage.example/part" }],
        nextAfterPartNumber: null
      });
    });
    await expect(
      uploadPartitionDataset({
        context: { ...context(remote), signal: caller.signal },
        filePath: source,
        name: "source.csv",
        mediaType: "text/csv",
        dataset: "business",
        enterpriseName: "Synthetic",
        startDate: "20261001",
        endDate: "20261002",
        idempotencyKey: "cancel"
      })
    ).rejects.toThrow("cancelled");
    expect(cleanupSignal).toBeInstanceOf(AbortSignal);
    expect(cleanupSignal!.aborted).toBe(false);
    expect(remote.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("aborts the server session when a multipart transfer cannot complete", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const source = path.join(root, "source.csv");
    await writeFile(source, "source");
    const methods: string[] = [];
    const fetchImplementation = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        methods.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/v1/structured/partition-uploads"))
          return Response.json(
            {
              partitionImportJobId: "pjob_abort",
              status: "uploading",
              partSize: 16,
              parts: [{ partNumber: 1, uploadUrl: "https://storage.example/part" }],
              nextAfterPartNumber: null
            },
            { status: 201 }
          );
        if (url === "https://storage.example/part") return new Response(null, { status: 503 });
        if (url.endsWith("/pjob_abort") && init?.method === "DELETE") return Response.json({});
        throw new Error(`Unexpected request ${url}`);
      }
    ) as unknown as typeof fetch;

    await expect(
      uploadPartitionDataset({
        context: context(fetchImplementation),
        filePath: source,
        name: "source.csv",
        mediaType: "text/csv",
        dataset: "business",
        enterpriseName: "Synthetic",
        startDate: "20260907",
        endDate: "20260913",
        idempotencyKey: "abort"
      })
    ).rejects.toThrow("failed with 503");
    expect(methods.filter((value) => value.startsWith("PUT "))).toHaveLength(3);
    expect(methods).toContain(
      "DELETE https://hub.example/v1/structured/partition-uploads/pjob_abort"
    );
  });

  it("downloads and verifies a sanitized local extract manifest", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const bytes = Buffer.from("header\nvalue\n");
    const source = path.join(root, "partition.csv");
    await writeFile(source, bytes);
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json({
        dataset: "dishes",
        enterpriseName: "Synthetic",
        startDate: "2026-09-07",
        endDate: "2026-09-13",
        partitionCount: 1,
        totalRowCount: 1,
        expiresAt: new Date().toISOString(),
        partitions: [
          {
            businessDate: "2026-09-07",
            storeId: "001",
            storeName: "Store A",
            rowCount: 1,
            byteSize: bytes.length,
            checksumSha256: createHash("sha256").update(bytes).digest("hex"),
            presignedDownloadUrl: pathToFileURL(source).href
          }
        ]
      })
    );
    const result = (await downloadPartitionDataset({
      context: context(fetchImplementation),
      dataset: "dishes",
      enterpriseName: "Synthetic",
      startDate: "20260907",
      endDate: "20260913",
      storeNameContains: ["麦家小馆"]
    })) as { localDirectory: string; files: string[] };
    expect(JSON.parse(String(fetchImplementation.mock.calls[0]![1]?.body))).toMatchObject({
      storeNameContains: ["麦家小馆"]
    });
    expect(result.files).toHaveLength(1);
    const localManifest = await readFile(path.join(result.localDirectory, "manifest.json"), "utf8");
    expect(localManifest).not.toContain("presignedDownloadUrl");
    expect(localManifest).not.toContain("file://");
    await rm(result.localDirectory, { recursive: true, force: true });
  });

  it("refreshes an expired manifest once before completing the extract", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "launcher-partition-"));
    const bytes = Buffer.from("header\nvalue\n");
    let manifestRequests = 0;
    const fetchImplementation = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/v1/structured/partition-manifests")) {
        manifestRequests += 1;
        return Response.json({
          dataset: "business",
          enterpriseName: "Synthetic",
          startDate: "2026-09-07",
          endDate: "2026-09-07",
          partitionCount: 1,
          totalRowCount: 1,
          partitions: [
            {
              businessDate: "2026-09-07",
              storeId: "001",
              storeName: "Store A",
              rowCount: 1,
              byteSize: bytes.length,
              checksumSha256: createHash("sha256").update(bytes).digest("hex"),
              presignedDownloadUrl:
                manifestRequests === 1
                  ? "https://storage.example/expired"
                  : "https://storage.example/fresh"
            }
          ]
        });
      }
      if (url.endsWith("/expired")) return new Response(null, { status: 403 });
      if (url.endsWith("/fresh")) return new Response(bytes, { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const result = (await downloadPartitionDataset({
      context: context(fetchImplementation),
      dataset: "business",
      enterpriseName: "Synthetic",
      startDate: "20260907",
      endDate: "20260907"
    })) as { localDirectory: string; files: string[] };

    expect(manifestRequests).toBe(2);
    expect(result.files).toHaveLength(1);
    await rm(result.localDirectory, { recursive: true, force: true });
  });
});

function context(fetchImplementation: typeof fetch) {
  return {
    serviceUrl: "https://hub.example",
    accessToken: "secret",
    launcherVersion: "0.4.0",
    fetchImplementation
  };
}

describe("partition transfer deadlines and credentials", () => {
  afterEach(() => vi.useRealTimers());
  it("forces one replacement token and rebuilds the rejected authorization header", async () => {
    const { apiJson } = await import("./partition-transfer.js");
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer secret"
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true })
    );
    const refreshAccessToken = vi.fn(async () => "replacement");
    await expect(
      apiJson({ ...context(fetcher), refreshAccessToken }, "/manifest", { method: "POST" })
    ).resolves.toEqual({ ok: true });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("authorization")).toBe(
      "Bearer replacement"
    );
  });
  it("rejects a cached rejected token and never refreshes twice", async () => {
    const { apiJson } = await import("./partition-transfer.js");
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const refreshAccessToken = vi.fn(async () => "secret");
    await expect(
      apiJson({ ...context(fetcher), refreshAccessToken }, "/manifest", { method: "POST" })
    ).rejects.toThrow("did not replace");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["headers", "body"])("ends stalled API %s at 30 seconds", async (kind) => {
    const { apiJson } = await import("./partition-transfer.js");
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]
    });
    const fetcher = vi.fn<typeof fetch>(async () =>
      kind === "headers"
        ? new Promise<Response>(() => {})
        : new Response(new ReadableStream({ start() {} }))
    );
    const result = apiJson(context(fetcher), "/manifest", { method: "POST" });
    const rejected = expect(result).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["headers", "body"])(
    "ends stalled transfer %s at 30 seconds without retry",
    async (kind) => {
      const { downloadVerified } = await import("./partition-transfer.js");
      const root = await mkdtemp(path.join(os.tmpdir(), "transfer-timeout-"));
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]
      });
      const fetcher = vi.fn<typeof fetch>(async () =>
        kind === "headers"
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ start() {} }))
      );
      const result = downloadVerified(
        context(fetcher),
        "https://storage.example/file",
        path.join(root, "out"),
        1,
        "0".repeat(64)
      );
      const rejected = expect(result).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(1);
      await rm(root, { recursive: true, force: true });
    }
  );
  it("caps progressing transfers at the 240-second invocation budget", async () => {
    const { boundedInvocation, downloadVerified } = await import("./partition-transfer.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "transfer-budget-"));
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]
    });
    let timer: ReturnType<typeof setInterval>;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              timer = setInterval(() => controller.enqueue(Buffer.from("x")), 20_000);
            },
            cancel() {
              clearInterval(timer);
            }
          })
        )
    );
    const result = boundedInvocation(context(fetcher), (context) =>
      downloadVerified(
        context,
        "https://storage.example/file",
        path.join(root, "out"),
        100,
        "0".repeat(64)
      )
    );
    const rejected = expect(result).rejects.toThrow("deadline");
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    await rm(root, { recursive: true, force: true });
  });
  it("retries 503 exactly three attempts and stops cancellation during backoff", async () => {
    const { downloadVerified } = await import("./partition-transfer.js");
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const result = downloadVerified(
      context(fetcher),
      "https://storage.example/file",
      "/unused",
      0,
      "0".repeat(64)
    );
    const rejected = expect(result).rejects.toThrow("503");
    await vi.advanceTimersByTimeAsync(750);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear();
    const controller = new AbortController();
    const canceled = downloadVerified(
      { ...context(fetcher), signal: controller.signal },
      "https://storage.example/file",
      "/unused",
      0,
      "0".repeat(64)
    );
    const canceledAssertion = expect(canceled).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(1000);
    await canceledAssertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("cancels sibling legacy downloads after the first validation failure", async () => {
  const before = await import("node:fs/promises")
    .then((fs) => fs.readdir(path.join(os.tmpdir(), "smedc-partition-extracts")))
    .catch((): string[] => []);
  let siblingSignal: AbortSignal | null | undefined;
  const cancelled = vi.fn();
  const bytes = Buffer.from("x");
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes("partition-manifests"))
      return Response.json({
        dataset: "business",
        enterpriseName: "Synthetic",
        startDate: "2026-09-07",
        endDate: "2026-09-07",
        partitionCount: 2,
        totalRowCount: 2,
        partitions: ["bad", "stalled"].map((storeId) => ({
          businessDate: "2026-09-07",
          storeId,
          storeName: storeId,
          rowCount: 1,
          byteSize: 1,
          checksumSha256: "0".repeat(64),
          presignedDownloadUrl: `https://storage.example/${storeId}`
        }))
      });
    if (String(url).endsWith("/bad")) return new Response(bytes);
    siblingSignal = init?.signal;
    return new Response(new ReadableStream({ cancel: cancelled }));
  });
  await expect(
    downloadPartitionDataset({
      context: context(fetcher),
      dataset: "business",
      enterpriseName: "Synthetic",
      startDate: "20260907",
      endDate: "20260907"
    })
  ).rejects.toThrow("checksum");
  expect(siblingSignal?.aborted).toBe(true);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(3);
  const after = await import("node:fs/promises").then((fs) =>
    fs.readdir(path.join(os.tmpdir(), "smedc-partition-extracts"))
  );
  expect(after.filter((directory) => !before.includes(directory))).toEqual([]);
});
