import type { LauncherRuntimeConfig } from "../apps/mcp-launcher/src/config.js";
import { csrfTokenForSecret } from "../apps/api/src/auth/http-contract.js";
import {
  type LauncherAuthentication,
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

const baseUrl = process.env["SMEDC_BASE_URL"];

try {
  assert(baseUrl, "SMEDC_BASE_URL must point at a running local SMEDC API.");
  const expectedSecureStore = process.env["LAUNCHER_EXPECT_SECURE_STORE"] === "1";
  const employeeEmail = process.env["LAUNCHER_EMPLOYEE_EMAIL"];
  const employeePassword = process.env["LAUNCHER_EMPLOYEE_PASSWORD"];
  const config: LauncherRuntimeConfig = { serviceUrl: baseUrl, transport: "stdio" };
  const dependencies = createLauncherToolDependencies({ config });

  const selfCheck = await dependencies.auth.selfCheck();
  assert(selfCheck.server.reachable, "Launcher self-check must reach the API.");
  assert(
    selfCheck.secureStore.available === expectedSecureStore,
    `Secure-store availability must match the environment expectation (${expectedSecureStore}).`
  );
  assert(selfCheck.launcherVersion === "0.5.2", "Launcher self-check must report 0.5.2.");

  const loginResult = await createLauncherToolHandler("smedc_login", dependencies)({});
  assert(!loginResult.isError, "Device login must not fail on a headless host.");
  const body = JSON.parse(loginResult.content[0]?.text ?? "null") as LoginResultBody;
  assert(body.flow === "device", "Login must use the device flow.");
  assert(Boolean(body.verificationUriComplete && body.userCode), "Login must return the tap link.");
  assert(body.openedBrowser === canOpenBrowser(), "Link delivery must match browser availability.");
  assert(body.serviceUrl === baseUrl, "Login result must carry the service URL.");

  const statusResult = await createLauncherToolHandler("smedc_auth_status", dependencies)({});
  const status = JSON.parse(statusResult.content[0]?.text ?? "null") as {
    authenticated: boolean;
  };
  assert(!status.authenticated, "Auth status must remain unauthenticated until the link is used.");

  const proved = ["device_self_check", "device_login_link", "headless_link_delivery"];
  if (employeeEmail && employeePassword) {
    await completeDeviceVerification({
      baseUrl,
      verificationUriComplete: body.verificationUriComplete!,
      email: employeeEmail,
      password: employeePassword
    });
    await waitForAuthenticated(dependencies.auth);
    const currentUserResult = await createLauncherToolHandler(
      "smedc_get_current_user",
      dependencies
    )({});
    assert(
      !currentUserResult.isError,
      "Authenticated business tool must succeed after device login."
    );
    const currentUser = JSON.parse(currentUserResult.content[0]?.text ?? "null") as {
      employee?: { clearance?: unknown };
    };
    assert(
      typeof currentUser.employee?.clearance === "number",
      "Current-user tool must return clearance."
    );
    proved.push("device_full_loop");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        launcherVersion: "0.5.2",
        secureStoreAvailable: selfCheck.secureStore.available,
        flow: body.flow,
        openedBrowser: body.openedBrowser,
        proved
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

async function completeDeviceVerification(input: {
  baseUrl: string;
  verificationUriComplete: string;
  email: string;
  password: string;
}): Promise<void> {
  const page = await fetch(input.verificationUriComplete, { redirect: "manual" });
  assert(page.status === 200, `Verification page must render (${page.status}).`);
  const setCookie = page.headers.get("set-cookie") ?? "";
  const verifySecret = /__Host-eh_device_verify=([^;]+)/.exec(setCookie)?.[1];
  assert(Boolean(verifySecret), "Verification page must issue its secure cookie.");
  const userCode = new URL(input.verificationUriComplete).searchParams.get("user_code") ?? "";
  const response = await fetch(`${input.baseUrl}/oauth/device/verify/login`, {
    method: "POST",
    headers: {
      cookie: `__Host-eh_device_verify=${verifySecret}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      csrfToken: csrfTokenForSecret(verifySecret!),
      userCode,
      email: input.email,
      password: input.password
    }).toString()
  });
  assert(
    response.status === 200,
    `Verification login must succeed (${response.status}): ${(await response.text()).slice(0, 200)}`
  );
}

async function waitForAuthenticated(auth: LauncherAuthentication): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await auth.status()).authenticated) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Launcher did not become authenticated after device completion.");
}
