export interface LauncherRuntimeConfig {
  serviceUrl: string;
  transport: "stdio";
}

export interface LauncherRuntimeConfigInput {
  enterpriseHubBaseUrl: string;
}

type LauncherRuntimeEnv = Partial<
  Record<"ENTERPRISE_HUB_BASE_URL" | "NODE_ENV", string | undefined>
>;

const CONFIG_INPUT_KEYS = new Set(["enterpriseHubBaseUrl"]);

export function createLauncherRuntimeConfig(
  input: LauncherRuntimeConfigInput
): LauncherRuntimeConfig {
  assertOnlyBaseUrlInput(input);

  return {
    serviceUrl: normalizeEnterpriseHubBaseUrl(input.enterpriseHubBaseUrl),
    transport: "stdio"
  };
}

export function loadLauncherRuntimeConfig(
  env: LauncherRuntimeEnv = process.env
): LauncherRuntimeConfig {
  const enterpriseHubBaseUrl = env.ENTERPRISE_HUB_BASE_URL;

  if (!enterpriseHubBaseUrl) {
    throw new Error("ENTERPRISE_HUB_BASE_URL is required.");
  }

  return {
    serviceUrl: normalizeEnterpriseHubBaseUrl(enterpriseHubBaseUrl, env.NODE_ENV === "test"),
    transport: "stdio"
  };
}

function assertOnlyBaseUrlInput(input: LauncherRuntimeConfigInput): void {
  const keys = Object.keys(input);

  if (keys.some((key) => !CONFIG_INPUT_KEYS.has(key))) {
    throw new Error("Launcher config accepts only enterpriseHubBaseUrl.");
  }
}

function normalizeEnterpriseHubBaseUrl(value: string, allowLoopbackHttp = false): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Enterprise Hub base URL is required.");
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enterprise Hub base URL must be an http(s) URL.");
  }

  const loopbackHttp =
    allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("Enterprise Hub base URL must be a canonical HTTPS origin.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Enterprise Hub base URL must not include credentials, query, or hash.");
  }

  if (!/^\/$/.test(url.pathname.replace(/\/+$/, "/"))) {
    throw new Error("Enterprise Hub base URL must be a canonical HTTPS origin.");
  }

  return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return new Set(["127.0.0.1", "localhost", "[::1]"]).has(hostname);
}
