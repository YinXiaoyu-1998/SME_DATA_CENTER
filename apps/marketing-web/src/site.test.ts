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
      expect(html).toMatch(/href="#contact"[^>]*>预约演示/);
      expect(html).toContain('id="contact"');
      expect(html).toContain('href="tel:18514577162"');
      expect(html).toContain('href="mailto:consyinxy@gmail.com?subject=');
      expect(html).toContain('href="#scenarios"');
      expect(html).toMatch(/<details>[\s\S]*?<summary>/);
      expect(html).not.toMatch(/<form\b/);
      const client = await readFile(join(directory, "client.js"), "utf8");
      expect(() => new Script(client)).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("contact copy interaction", () => {
  it("copies the contact details and announces success only after clipboard access succeeds", async () => {
    const { buildSite } = await import("./build.js");
    const directory = await mkdtemp(join(tmpdir(), "smedc-contact-"));
    try {
      await buildSite(directory);
      const client = await readFile(join(directory, "client.js"), "utf8");
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
      const client = await readFile(join(directory, "client.js"), "utf8");
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
