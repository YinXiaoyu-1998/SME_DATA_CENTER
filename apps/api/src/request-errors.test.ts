import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PublicRequestError, registerApiErrorHandler } from "./request-errors.js";

describe("API request error boundary", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("sanitizes malformed JSON instead of returning parser details", async () => {
    app = Fastify({ logger: false });
    registerApiErrorHandler(app);
    app.post("/json", async (request) => request.body);

    const response = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: '{"broken":'
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Request is invalid.",
        requestId: expect.any(String)
      }
    });
    expect(response.payload).not.toContain("Unexpected end");
  });

  it("serializes explicit public request errors without exposing a cause", async () => {
    app = Fastify({ logger: false });
    registerApiErrorHandler(app);
    app.get("/bounded", async () => {
      throw new PublicRequestError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Request payload is too large.",
        new Error("sensitive multipart parser detail")
      );
    });

    const response = await app.inject({ method: "GET", url: "/bounded" });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request payload is too large.",
        requestId: expect.any(String)
      }
    });
    expect(response.payload).not.toContain("sensitive multipart parser detail");
  });
});
