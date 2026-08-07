import type { LauncherRuntimeConfig } from "../apps/mcp-launcher/src/config.js";
import {
  canOpenBrowser,
  createLauncherToolDependencies,
  createLauncherToolHandler
} from "../apps/mcp-launcher/src/launcher.js";

interface LoginResultBody {
  authenticated: boolean;
  flow?: "device";
  verificationUriComplete?: string;
  verificationUri?: string;
  userCode?: string;
  instanceName?: string;
  instanceHostname?: string;
  openedBrowser?: boolean;
  serviceUrl?: string;
}

const baseUrl = process.env["ENTERPRISE_HUB_BASE_URL"];

try {
  assert(baseUrl, "ENTERPRISE_HUB_BASE_URL must point at a running local Enterprise Hub API.");
  const expectedSecureStore = process.env["LAUNCHER_EXPECT_SECURE_STORE"] === "1";
  const config: LauncherRuntimeConfig = { serviceUrl: baseUrl, transport: "stdio" };
  const dependencies = createLauncherToolDependencies({ config });

  const selfCheck = await dependencies.auth.selfCheck();
  assert(selfCheck.server.reachable, "Launcher self-check must reach the API.");
  assert(
    selfCheck.secureStore.available === expectedSecureStore,
    `Secure-store availability must match the environment expectation (${expectedSecureStore}).`
  );
  assert(selfCheck.launcherVersion === "0.2.0", "Launcher self-check must report 0.2.0.");

  const loginResult = await createLauncherToolHandler("enterprise_hub_login", dependencies)({});
  assert(!loginResult.isError, "Device login must not fail on a headless host.");
  const body = JSON.parse(loginResult.content[0]?.text ?? "null") as LoginResultBody;
  assert(body.flow === "device", "Login must use the device flow.");
  assert(Boolean(body.verificationUriComplete && body.userCode), "Login must return the tap link.");
  assert(body.openedBrowser === canOpenBrowser(), "Link delivery must match browser availability.");
  assert(body.serviceUrl === baseUrl, "Login result must carry the service URL.");

  const statusResult = await createLauncherToolHandler(
    "enterprise_hub_auth_status",
    dependencies
  )({});
  const status = JSON.parse(statusResult.content[0]?.text ?? "null") as {
    authenticated: boolean;
  };
  assert(!status.authenticated, "Auth status must remain unauthenticated until the link is used.");

  console.log(
    JSON.stringify(
      {
        ok: true,
        launcherVersion: "0.2.0",
        secureStoreAvailable: selfCheck.secureStore.available,
        flow: body.flow,
        openedBrowser: body.openedBrowser,
        proved: ["device_self_check", "device_login_link", "headless_link_delivery"]
      },
      null,
      2
    )
  );
} catch (error: unknown) {
  console.error(errorToMessage(error));
  process.exitCode = 1;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
