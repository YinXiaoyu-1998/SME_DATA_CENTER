import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

describe("public marketing page", () => {
  it("lets a visitor reach contact and use phone or email without JavaScript", async () => {
    const { buildSite } = await import("./build.js");
    const directory = await mkdtemp(join(tmpdir(), "smedc-site-"));
    try {
      await buildSite(directory);
      const html = await readFile(join(directory, "index.html"), "utf8");
      expect(html).toMatch(/href="#contact"[^>]*>聊聊您的门店/);
      expect(html).toContain('id="contact"');
      expect(html).toContain('href="tel:18514577162"');
      expect(html).toContain('href="mailto:consyinxy@gmail.com?subject=');
      expect(html).toContain('href="#reports"');
      expect(html).toMatch(/<details>[\s\S]*?<summary>/);
      expect(html).not.toMatch(/<form\b/);
      expect(html).toContain('data-composition-id="smedc-setup"');
      expect(html).toContain('id="copy-setup-prompt"');
      expect(html).not.toContain("__SETUP_DEMO__");
      expect(html).not.toMatch(/<script[^>]+src="https?:/);
      const client = await readFile(join(directory, "client.js"), "utf8");
      expect(() => new Script(client)).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("ships the anonymized, interactive report as a lazy isolated reader with a direct-link fallback", async () => {
  const { buildSite } = await import("./build.js");
  const directory = await mkdtemp(join(tmpdir(), "smedc-report-sample-"));
  try {
    await buildSite(directory);
    const html = await readFile(join(directory, "index.html"), "utf8");
    expect(html).toContain('href="/samples/weekly-report.html"');
    const iframe = html.match(/<iframe\b[^>]*>/)?.[0];
    expect(iframe).toContain('sandbox="allow-scripts"');
    expect(iframe).toContain('data-src="/samples/weekly-report.html?v=');
    expect(iframe).not.toMatch(/\ssrc=/);
    const report = await readFile(join(directory, "samples/weekly-report.html"), "utf8");
    const serialized = report.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(serialized).toBeDefined();
    const data = JSON.parse(serialized!);
    expect(data.meta.company).toBe("某餐饮企业");
    expect(data.meta.anonymized_sample).toBe(true);
    expect(Object.keys(data.meta.store_groups).sort()).toEqual(
      "ABCDEFGHIJ".split("").map((letter) => `门店 ${letter}`)
    );
    expect(data.comparison).toHaveLength(10);
    for (const row of data.comparison) expect(row["门店名称"]).toMatch(/^门店 [A-J]$/);
    expect(report).not.toMatch(/<style\b|\sstyle=/);
    for (const script of report.matchAll(/<script\b([^>]*)>/g)) {
      const attributes = script[1] ?? "";
      expect(
        attributes.includes('type="application/json"') ||
          attributes.includes('src="/samples/weekly-report.js"')
      ).toBe(true);
    }
    const runtime = await readFile(join(directory, "samples/weekly-report.js"), "utf8");
    expect(() => new Script(runtime)).not.toThrow();
    expect(runtime).not.toMatch(/\sstyle=/);
    expect(await readFile(join(directory, "samples/weekly-report.css"), "utf8")).toContain(
      'data-sample-color="#006d77"'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("contact copy interaction", () => {
  it("copies the contact details and announces success only after clipboard access succeeds", async () => {
    const { buildSite } = await import("./build.js");
    const directory = await mkdtemp(join(tmpdir(), "smedc-contact-"));
    try {
      await buildSite(directory);
      const { clientSource: client } = await import("./client.js");
      let click: (() => Promise<void>) | undefined;
      let copied = "";
      const button = {
        hidden: true,
        addEventListener: (_event: string, handler: () => Promise<void>) => {
          click = handler;
        }
      };
      const status = { textContent: "" };
      new Script(client).runInNewContext({
        document: { getElementById: (id: string) => (id === "copy-contact" ? button : status) },
        navigator: {
          clipboard: {
            writeText: async (text: string) => {
              copied = text;
            }
          }
        }
      });
      expect(button.hidden).toBe(false);
      expect(click).toBeDefined();
      await click!();
      expect(copied).toBe("企业智脑 SMEDC\n电话：18514577162\n邮箱：consyinxy@gmail.com");
      expect(status.textContent).toContain("已复制");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it.each(["denied", "unavailable"])(
  "keeps a manual copy path when clipboard access is %s",
  async (failure) => {
    const { buildSite } = await import("./build.js");
    const directory = await mkdtemp(join(tmpdir(), "smedc-contact-"));
    try {
      await buildSite(directory);
      const { clientSource: client } = await import("./client.js");
      let click: (() => Promise<void>) | undefined;
      const button = {
        hidden: true,
        addEventListener: (_event: string, handler: () => Promise<void>) => {
          click = handler;
        }
      };
      const status = { textContent: "" };
      new Script(client).runInNewContext({
        document: { getElementById: (id: string) => (id === "copy-contact" ? button : status) },
        navigator:
          failure === "unavailable"
            ? {}
            : {
                clipboard: {
                  writeText: async () => {
                    throw new Error("denied");
                  }
                }
              }
      });
      await click!();
      expect(status.textContent).toContain("手动复制");
      expect(status.textContent).not.toContain("已复制");
      const html = await readFile(join(directory, "index.html"), "utf8");
      expect(html).toMatch(/>\s*consyinxy@gmail\.com\s*<\/a\s*>/);
      expect(html).toMatch(/>\s*18514577162\s*<\/a\s*>/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each([false, true])("keeps content readable with reduced motion set to %s", async (reduced) => {
  const { clientSource } = await import("./client.js");
  const classes = new Set<string>();
  let animations = 0;
  let unobserved = 0;
  let intersect:
    ((entries: { isIntersecting: boolean; target: typeof element }[]) => void) | undefined;
  const element = {
    style: { transitionDelay: "" },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name)
    },
    getBoundingClientRect: () => ({ top: 1000 }),
    animate: () => {
      animations++;
      return { cancel: () => {} };
    }
  };
  class Observer {
    constructor(callback: typeof intersect) {
      intersect = callback;
    }
    observe() {}
    unobserve() {
      unobserved++;
    }
    disconnect() {}
  }
  new Script(clientSource).runInNewContext({
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        ["[data-reveal]", "[data-entrance]"].includes(selector) ? [element] : [],
      addEventListener: () => {},
      documentElement: { scrollHeight: 2000 }
    },
    window: {
      matchMedia: () => ({ matches: reduced, addEventListener: () => {} }),
      addEventListener: () => {},
      innerHeight: 800,
      scrollY: 0,
      location: { hash: "" },
      IntersectionObserver: Observer
    },
    IntersectionObserver: Observer
  });
  expect(animations).toBe(reduced ? 0 : 1);
  expect(classes.has("is-pending")).toBe(!reduced);
  if (!reduced) {
    intersect!([{ isIntersecting: true, target: element }]);
    expect(classes.has("is-pending")).toBe(false);
    expect(classes.has("is-revealed")).toBe(true);
    expect(unobserved).toBe(1);
  }
});

it.each([false, true])(
  "copies the complete setup request while typing (clipboard denied: %s)",
  async (denied) => {
    const { setupPlayerSource } = await import("./setup-player.js");
    const prompt =
      "帮我安装或更新 https://github.com/YinXiaoyu-1998/smedc-mcp-skill 的核心和配套 SKILL，并按官方说明安装、配置最新版 MCP。完成后告诉我如何登录。";
    let click: (() => Promise<void>) | undefined;
    let copied = "";
    const button = {
      hidden: true,
      addEventListener: (_event: string, handler: () => Promise<void>) => {
        click = handler;
      }
    };
    const status = { textContent: "" };
    const root = {
      dataset: { installPrompt: prompt },
      querySelector: () => ({ textContent: "帮我" })
    };
    new Script(setupPlayerSource).runInNewContext({
      document: {
        getElementById: (id: string) =>
          id === "smedc-setup" ? root : id === "copy-setup-prompt" ? button : status
      },
      window: { matchMedia: () => ({ matches: false }) },
      navigator: {
        clipboard: {
          writeText: async (text: string) => {
            if (denied) throw new Error("denied");
            copied = text;
          }
        }
      }
    });
    expect(button.hidden).toBe(false);
    await click!();
    expect(copied).toBe(denied ? "" : prompt);
    expect(status.textContent).toContain(denied ? "手动复制" : "已复制");
  }
);

it("shows the complete setup illustration without playback when reduced motion is requested", async () => {
  const { setupPlayerSource } = await import("./setup-player.js");
  let plays = 0;
  const root = { dataset: { installPrompt: "安装 SMEDC", demoState: "" } };
  const control = { hidden: true, textContent: "", value: "", max: "", addEventListener: () => {} };
  const playback = { hidden: false };
  const timeline = {
    progress: () => timeline,
    pause: () => timeline,
    play: () => {
      plays++;
      return timeline;
    },
    duration: () => 14.6,
    time: () => 14.6,
    eventCallback: () => {}
  };
  new Script(setupPlayerSource).runInNewContext({
    document: {
      getElementById: (id: string) => (id === "smedc-setup" ? root : control),
      querySelector: () => playback,
      addEventListener: () => {}
    },
    window: {
      matchMedia: () => ({ matches: true, addEventListener: () => {} }),
      __timelines: { "smedc-setup": timeline }
    }
  });
  expect(root.dataset.demoState).toBe("static");
  expect(playback.hidden).toBe(true);
  expect(plays).toBe(0);
});
