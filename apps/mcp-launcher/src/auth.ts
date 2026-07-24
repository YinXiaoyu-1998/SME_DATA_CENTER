import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

export const OAUTH_CLIENT_ID = "enterprise-hub-desktop-launcher";
export const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SecureCredentialStore {
  get(): Promise<string | null>;
  set(credential: string): Promise<void>;
  delete(): Promise<void>;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  verifier: string;
}

export interface LoopbackCallbackServer {
  redirectUri: URL;
  waitForResult(): Promise<{ received: true }>;
  close(): Promise<void>;
}

interface InternalLoopbackCallbackServer extends LoopbackCallbackServer {
  waitForCode(): Promise<string>;
}

export async function createAuthorizationRequest(input: {
  authorizationEndpoint: URL;
  redirectUri: URL;
  state?: string;
  verifier?: string;
}): Promise<AuthorizationRequest> {
  const state = input.state ?? randomBase64Url(32);
  const verifier = input.verifier ?? randomBase64Url(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(input.authorizationEndpoint);

  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri.toString());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return { url, state, verifier };
}

export async function createLoopbackCallbackServer(input: {
  state: string;
  timeoutMs?: number;
}): Promise<LoopbackCallbackServer> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await listenForCallback(input);
    } catch (error) {
      if (attempt === 1 || !isBindFailure(error)) {
        throw new Error("Unable to start the secure browser callback.");
      }
    }
  }

  throw new Error("Unable to start the secure browser callback.");
}

export async function waitForAuthorizationCode(callback: LoopbackCallbackServer): Promise<string> {
  return (callback as InternalLoopbackCallbackServer).waitForCode();
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSecretKey(key) ? "[REDACTED]" : redactSecrets(item)
    ])
  );
}

function listenForCallback(input: {
  state: string;
  timeoutMs?: number;
}): Promise<InternalLoopbackCallbackServer> {
  return new Promise((resolve, reject) => {
    let complete = false;
    let resolveCode: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    const codePromise = new Promise<string>((resolveCodePromise, rejectCodePromise) => {
      resolveCode = resolveCodePromise;
      rejectCode = rejectCodePromise;
    });
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method !== "GET" || requestUrl.pathname !== CALLBACK_PATH || complete) {
        sendCallbackResponse(response, 400, "The sign-in callback is invalid.");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");

      if (!code || !state || state !== input.state) {
        sendCallbackResponse(response, 400, "The sign-in callback could not be verified.");
        return;
      }

      complete = true;
      clearTimeout(timeout);
      sendCallbackResponse(response, 200, "Sign-in completed. You can return to Enterprise Hub.");
      resolveCode?.(code);
    });
    const timeout = setTimeout(() => {
      if (!complete) {
        complete = true;
        rejectCode?.(new Error("Browser sign-in timed out."));
        void closeServer(server);
      }
    }, input.timeoutMs ?? CALLBACK_TIMEOUT_MS);

    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        clearTimeout(timeout);
        void closeServer(server);
        reject(new Error("Loopback callback did not bind to IPv4."));
        return;
      }

      const callback: InternalLoopbackCallbackServer = {
        redirectUri: new URL(`http://127.0.0.1:${address.port}${CALLBACK_PATH}`),
        waitForResult: async () => {
          await codePromise;
          return { received: true };
        },
        waitForCode: () => codePromise,
        close: async () => {
          clearTimeout(timeout);
          if (!complete) {
            complete = true;
            rejectCode?.(new Error("Browser sign-in was cancelled."));
          }
          await closeServer(server);
        }
      };

      resolve(callback);
    });
  });
}

function sendCallbackResponse(
  response: http.ServerResponse,
  status: number,
  message: string
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`<!doctype html><title>Enterprise Hub</title><p>${message}</p>`);
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function isBindFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EADDRINUSE", "EACCES"].includes(String((error as { code?: unknown }).code))
  );
}

function isSecretKey(key: string): boolean {
  return /(?:token|authorization|cookie|password|credential|code|secret)/i.test(key);
}
