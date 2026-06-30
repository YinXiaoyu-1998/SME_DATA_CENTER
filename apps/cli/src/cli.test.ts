import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function createIo() {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        }
      }
    },
    stdout() {
      return stdout;
    },
    stderr() {
      return stderr;
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("hub cli", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function createRuntime(fetchImpl: typeof fetch) {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-cli-test-"));
    const io = createIo();

    return {
      cwd: tempDir,
      env: {
        HUB_API_URL: "http://api.test"
      },
      fetch: fetchImpl,
      io: io.io,
      stdout: io.stdout,
      stderr: io.stderr,
      sessionFile: path.join(tempDir, ".data", "hub-cli", "session.json")
    };
  }

  it("logs in with a seeded employee and stores the token without printing it", async () => {
    const calls: FetchCall[] = [];
    const runtime = await createRuntime(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        accessToken: "secret-dev-token",
        employee: {
          id: "emp_baoli_manager",
          email: "baoli.manager@example.com",
          role: "manager",
          labels: ["all_staff", "person:baoli.manager", "store:baoli"]
        }
      });
    });

    const exitCode = await runCli(["login", "--email", "baoli.manager@example.com"], runtime);

    expect(exitCode).toBe(0);
    expect(calls[0]).toMatchObject({
      url: "http://api.test/auth/dev-login",
      init: {
        method: "POST"
      }
    });
    expect(JSON.parse(runtime.stdout())).toMatchObject({
      ok: true,
      apiUrl: "http://api.test",
      employee: {
        email: "baoli.manager@example.com"
      },
      sessionFile: runtime.sessionFile
    });
    expect(runtime.stdout()).not.toContain("secret-dev-token");
    expect(await readFile(runtime.sessionFile, "utf8")).toContain("secret-dev-token");
  });

  it("searches documents through the API with the stored employee token", async () => {
    const calls: FetchCall[] = [];
    const runtime = await createRuntime(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        documents: [
          {
            id: "doc_baoli",
            title: "Baoli June Meituan Export",
            status: "active"
          }
        ],
        nextCursor: null
      });
    });
    await writeSession(runtime.sessionFile);

    const exitCode = await runCli(["documents", "search", "保利店 美团"], runtime);

    expect(exitCode).toBe(0);
    expect(calls[0]?.url).toBe(
      "http://api.test/documents?q=%E4%BF%9D%E5%88%A9%E5%BA%97+%E7%BE%8E%E5%9B%A2"
    );
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer stored-token"
    });
    expect(JSON.parse(runtime.stdout()).documents).toEqual([
      {
        id: "doc_baoli",
        title: "Baoli June Meituan Export",
        status: "active"
      }
    ]);
  });

  it("uploads a fixture through multipart API request", async () => {
    const calls: FetchCall[] = [];
    const runtime = await createRuntime(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(
        {
          id: "doc_uploaded",
          title: "baoli.csv",
          status: "pending_processing",
          labels: ["person:baoli.manager", "store:baoli"]
        },
        201
      );
    });
    await writeSession(runtime.sessionFile);
    await writeFile(path.join(runtime.cwd, "baoli.csv"), "date,revenue\n2026-06-30,100\n");

    const exitCode = await runCli(
      ["documents", "upload", "baoli.csv", "--label", "store:baoli"],
      runtime
    );

    expect(exitCode).toBe(0);
    expect(calls[0]?.url).toBe("http://api.test/documents");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer stored-token"
    });
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);

    const form = calls[0]?.init?.body as FormData;
    expect(form.get("title")).toBe("baoli.csv");
    expect(form.get("documentType")).toBe("raw_material");
    expect(form.getAll("labelKeys[]")).toEqual(["store:baoli"]);
    expect(JSON.parse(runtime.stdout())).toMatchObject({
      id: "doc_uploaded",
      status: "pending_processing"
    });
  });
});

async function writeSession(sessionFile: string): Promise<void> {
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(
    sessionFile,
    JSON.stringify({
      apiUrl: "http://api.test",
      accessToken: "stored-token",
      employee: {
        id: "emp_baoli_manager",
        email: "baoli.manager@example.com",
        role: "manager",
        labels: ["all_staff", "person:baoli.manager", "store:baoli"]
      }
    })
  );
}
