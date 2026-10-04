import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseLedgerScope } from "@smedc/ledger-archive";
import {
  LedgerDeliveryError,
  type LedgerCoverageScope,
  type LedgerPdfDelivery
} from "@smedc/ledger-archive/delivery";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse } from "../request-errors.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
  return value as Record<string, unknown>;
}
function scopeBody(
  body: unknown,
  action: boolean
): { scope: LedgerCoverageScope; cursor?: string; idempotencyKey?: string } {
  const value = object(body);
  const allowed = action
    ? ["storeNames", "dates", "startDate", "endDate", "idempotencyKey"]
    : ["storeNames", "dates", "startDate", "endDate", "cursor"];
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
  if (
    action &&
    (typeof value["idempotencyKey"] !== "string" ||
      !value["idempotencyKey"] ||
      value["idempotencyKey"].length > 255)
  )
    throw new LedgerDeliveryError("LEDGER_SCOPE_INVALID");
  if (
    value["cursor"] !== undefined &&
    (typeof value["cursor"] !== "string" || !value["cursor"] || value["cursor"].length > 4096)
  )
    throw new LedgerDeliveryError("LEDGER_CURSOR_INVALID");
  if (
    (Array.isArray(value["storeNames"]) && value["storeNames"].length > 50) ||
    (Array.isArray(value["dates"]) && value["dates"].length > 366)
  )
    throw new LedgerDeliveryError("LEDGER_SCOPE_LIMIT_EXCEEDED");
  const raw = { ...value };
  delete raw["cursor"];
  delete raw["idempotencyKey"];
  const parsed = parseLedgerScope({
    ...raw,
    storeNames:
      !action && raw["storeNames"] === undefined ? ["__date_validation__"] : raw["storeNames"]
  });
  const scope: LedgerCoverageScope =
    raw["storeNames"] === undefined
      ? "dates" in parsed
        ? { dates: parsed.dates! }
        : { startDate: parsed.startDate, endDate: parsed.endDate }
      : parsed;
  return {
    scope,
    ...(value["cursor"] ? { cursor: value["cursor"] as string } : {}),
    ...(action ? { idempotencyKey: value["idempotencyKey"] as string } : {})
  };
}
function requestId(request: FastifyRequest): string {
  const id = object(request.params)["requestId"];
  if (typeof id !== "string" || !id || id.length > 128)
    throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
  return id;
}
export function registerLedgerPdfRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    ledgerPdfDeliveryEnabled: boolean;
    delivery: () => LedgerPdfDelivery;
  }
) {
  const register = (
    method: "GET" | "POST",
    url: string,
    operation: (request: FastifyRequest) => Promise<unknown>,
    accepted = false
  ) =>
    app.route({
      method,
      url,
      handler: async (request, reply) => {
        if (!(await dependencies.auth.authenticate(request, reply))) return;
        if (!dependencies.ledgerPdfDeliveryEnabled)
          return reply
            .code(503)
            .send(errorResponse("LEDGER_PDF_NOT_ENABLED", "Ledger PDF delivery is not enabled."));
        try {
          const result = await operation(request);
          return reply.code(accepted ? 202 : 200).send(result);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          const known = new Set([
            "LEDGER_SCOPE_INVALID",
            "LEDGER_SCOPE_LIMIT_EXCEEDED",
            "LEDGER_CURSOR_INVALID",
            "LEDGER_REQUEST_INVALID",
            "LEDGER_IDEMPOTENCY_CONFLICT",
            "LEDGER_PDF_UNAVAILABLE",
            "LEDGER_PDF_NOT_READY",
            "LEDGER_PDF_BUNDLE_STALE",
            "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED",
            "ADMIN_REQUIRED"
          ]);
          if (!known.has(code)) {
            request.log.error({ err: error }, "Ledger PDF request failed.");
            return reply
              .code(500)
              .send(errorResponse("INTERNAL_ERROR", "Ledger PDF request could not be completed."));
          }
          const status =
            code === "ADMIN_REQUIRED"
              ? 403
              : code === "LEDGER_PDF_UNAVAILABLE"
                ? 404
                : code === "LEDGER_IDEMPOTENCY_CONFLICT" ||
                    code === "LEDGER_PDF_BUNDLE_STALE" ||
                    code === "LEDGER_PDF_NOT_READY"
                  ? 409
                  : 400;
          return reply
            .code(status)
            .send(
              errorResponse(
                code,
                code === "LEDGER_PDF_UNAVAILABLE"
                  ? "Ledger PDF request is unavailable."
                  : code === "LEDGER_PDF_NOT_READY"
                    ? "Ledger PDFs are not ready. Refresh and retry."
                    : code === "LEDGER_PDF_BUNDLE_STALE"
                      ? "Prepare a new ledger PDF download."
                      : "Ledger PDF request was rejected."
              )
            );
        }
      }
    });
  const noQuery = (r: FastifyRequest) => {
    if (Object.keys(object(r.query)).length)
      throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
  };
  register("POST", "/v1/ledger-pdfs/coverage", (r) => {
    noQuery(r);
    const parsed = scopeBody(r.body, false);
    return dependencies.delivery().coverage({
      employee: dependencies.auth.employee(r),
      scope: parsed.scope,
      ...(parsed.cursor ? { cursor: parsed.cursor } : {})
    });
  });
  register(
    "POST",
    "/v1/ledger-pdfs/refresh",
    (r) => {
      noQuery(r);
      const parsed = scopeBody(r.body, true);
      const employee = dependencies.auth.employee(r);
      if (employee.role !== "admin") throw new LedgerDeliveryError("ADMIN_REQUIRED");
      return dependencies.delivery().refresh({
        employee,
        scope: parseLedgerScope(parsed.scope),
        idempotencyKey: parsed.idempotencyKey!
      });
    },
    true
  );
  register(
    "POST",
    "/v1/ledger-pdfs/downloads",
    (r) => {
      noQuery(r);
      const parsed = scopeBody(r.body, true);
      return dependencies.delivery().requestLedgerBundle({
        employee: dependencies.auth.employee(r),
        scope: parseLedgerScope(parsed.scope),
        idempotencyKey: parsed.idempotencyKey!
      });
    },
    true
  );
  register("GET", "/v1/ledger-pdfs/requests/:requestId", (r) => {
    const query = object(r.query);
    if (
      r.body !== undefined ||
      Object.keys(query).some((k) => k !== "cursor") ||
      (query["cursor"] !== undefined &&
        (typeof query["cursor"] !== "string" || !query["cursor"] || query["cursor"].length > 4096))
    )
      throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    return dependencies.delivery().status({
      employee: dependencies.auth.employee(r),
      requestId: requestId(r),
      ...(query["cursor"] ? { cursor: query["cursor"] as string } : {})
    });
  });
  register("POST", "/v1/ledger-pdfs/requests/:requestId/download-url", (r) => {
    noQuery(r);
    if (r.body !== undefined) throw new LedgerDeliveryError("LEDGER_REQUEST_INVALID");
    return dependencies
      .delivery()
      .issueLedgerBundleUrl({ employee: dependencies.auth.employee(r), requestId: requestId(r) });
  });
}
