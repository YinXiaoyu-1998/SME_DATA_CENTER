import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { PUBLIC_INPUT_LIMITS } from "@smedc/domain";
import { readMultipartFile, registerApiMultipart } from "./multipart.js";

describe("API multipart utilities", () => {
  it("reads mixed multipart file chunks into one buffer", async () => {
    const body = await readMultipartFile(
      (async function* () {
        yield Buffer.from("hello ");
        yield new Uint8Array(Buffer.from("from "));
        yield "multipart";
      })()
    );

    expect(body.toString("utf8")).toBe("hello from multipart");
  });

  it("registers the public multipart limits without route-specific parsing", async () => {
    const app = Fastify({ logger: false });

    registerApiMultipart(app, { maxUploadBytes: 1234 });
    app.post("/upload", async (request) => {
      const parts = [];
      for await (const part of request.parts()) {
        parts.push(part.type);
      }
      return { parts };
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/upload",
        headers: {
          "content-type": "multipart/form-data; boundary=test"
        },
        payload: [
          "--test",
          'Content-Disposition: form-data; name="field"',
          "",
          "value",
          "--test--",
          ""
        ].join("\r\n")
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ parts: ["field"] });
      expect(PUBLIC_INPUT_LIMITS.multipartFiles).toBeGreaterThan(0);
      expect(PUBLIC_INPUT_LIMITS.multipartFields).toBeGreaterThan(0);
      expect(PUBLIC_INPUT_LIMITS.multipartParts).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
