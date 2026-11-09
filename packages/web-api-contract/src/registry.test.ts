import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WEB_API_ROUTES,
  defineWebApiRoute,
  validateWebApiRoutes,
  type WebApiRoute
} from "./registry.js";

function route(overrides: Partial<WebApiRoute> = {}): WebApiRoute {
  return defineWebApiRoute({
    id: "permissions.categories.list",
    method: "GET",
    path: "/api/web/v1/orgs/:orgId/permissions/categories",
    auth: "session",
    params: z.object({ orgId: z.string() }),
    response: z.object({ categories: z.array(z.string()) }),
    errors: ["BROWSER_SIGN_IN_REQUIRED", "WEB_API_INVALID_REQUEST"],
    summary: "列出业务类别",
    ...overrides
  });
}

describe("web api registry", () => {
  it("accepts a well-formed route", () => {
    expect(() => validateWebApiRoutes({ routes: [route()] })).not.toThrow();
  });

  it("rejects routes outside the web prefix", () => {
    expect(() =>
      validateWebApiRoutes({ routes: [route({ path: "/v1/permissions/categories" })] })
    ).toThrow(/must live under/);
  });

  it("rejects duplicate ids and duplicate method+path", () => {
    expect(() => validateWebApiRoutes({ routes: [route(), route()] })).toThrow(
      /duplicate route id/
    );
    expect(() =>
      validateWebApiRoutes({
        routes: [route(), route({ id: "permissions.categories.listOther" })]
      })
    ).toThrow(/duplicate route method\+path/);
  });

  it("rejects write auth on GET and plain auth on mutations", () => {
    expect(() => validateWebApiRoutes({ routes: [route({ auth: "session-write" })] })).toThrow(
      /cannot require a write check on GET/
    );
    expect(() =>
      validateWebApiRoutes({
        routes: [route({ method: "POST", auth: "session" })]
      })
    ).toThrow(/without a write auth kind/);
  });

  it("requires the sign-in, write and validation error codes", () => {
    expect(() => validateWebApiRoutes({ routes: [route({ errors: ["INTERNAL_ERROR"] })] })).toThrow(
      /must declare BROWSER_SIGN_IN_REQUIRED|does not declare BROWSER_SIGN_IN_REQUIRED/
    );
    expect(() =>
      validateWebApiRoutes({
        routes: [
          route({
            method: "POST",
            auth: "session-write",
            body: z.object({ name: z.string() }),
            errors: ["BROWSER_SIGN_IN_REQUIRED", "WEB_API_INVALID_REQUEST"]
          })
        ]
      })
    ).toThrow(/does not declare BROWSER_SECURITY_CHECK_FAILED/);
    expect(() =>
      validateWebApiRoutes({
        routes: [route({ errors: ["BROWSER_SIGN_IN_REQUIRED"] })]
      })
    ).toThrow(/does not declare WEB_API_INVALID_REQUEST/);
  });

  it("rejects malformed ids, error codes and summaries", () => {
    expect(() => validateWebApiRoutes({ routes: [route({ id: "Permissions" })] })).toThrow(
      /dot-separated lowerCamelCase/
    );
    expect(() =>
      validateWebApiRoutes({
        routes: [route({ errors: ["BROWSER_SIGN_IN_REQUIRED", "WEB_API_INVALID_REQUEST", "bad"] })]
      })
    ).toThrow(/invalid error code/);
    expect(() => validateWebApiRoutes({ routes: [route({ summary: " " })] })).toThrow(
      /needs a summary/
    );
  });

  it("keeps the committed route table valid", () => {
    expect(() => validateWebApiRoutes({ routes: WEB_API_ROUTES })).not.toThrow();
  });
});
