export interface LauncherRuntimeConfig {
  serviceUrl: string;
  transport: "stdio";
}

export interface LauncherRuntimeConfigInput {
  enterpriseHubBaseUrl: string;
}

type LauncherRuntimeEnv = Partial<Record<"ENTERPRISE_HUB_BASE_URL", string | undefined>>;

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

  return createLauncherRuntimeConfig({ enterpriseHubBaseUrl });
}

function assertOnlyBaseUrlInput(input: LauncherRuntimeConfigInput): void {
  const keys = Object.keys(input);

  if (keys.some((key) => !CONFIG_INPUT_KEYS.has(key))) {
    throw new Error("Launcher config accepts only enterpriseHubBaseUrl.");
  }
}

function normalizeEnterpriseHubBaseUrl(value: string): string {
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

  if (url.protocol !== "https:") {
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
