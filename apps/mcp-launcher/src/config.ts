export interface LauncherRuntimeConfig {
  serviceUrl: string;
  transport: "stdio";
}

export interface LauncherRuntimeConfigInput {
  smedcBaseUrl: string;
}

type LauncherRuntimeEnv = Partial<Record<"SMEDC_BASE_URL", string | undefined>>;

const CONFIG_INPUT_KEYS = new Set(["smedcBaseUrl"]);

export function createLauncherRuntimeConfig(
  input: LauncherRuntimeConfigInput
): LauncherRuntimeConfig {
  assertOnlyBaseUrlInput(input);

  return {
    serviceUrl: normalizeSmedcBaseUrl(input.smedcBaseUrl),
    transport: "stdio"
  };
}

export function loadLauncherRuntimeConfig(
  env: LauncherRuntimeEnv = process.env
): LauncherRuntimeConfig {
  const smedcBaseUrl = env.SMEDC_BASE_URL;

  if (!smedcBaseUrl) {
    throw new Error("SMEDC_BASE_URL is required.");
  }

  return createLauncherRuntimeConfig({ smedcBaseUrl });
}

function assertOnlyBaseUrlInput(input: LauncherRuntimeConfigInput): void {
  const keys = Object.keys(input);

  if (keys.some((key) => !CONFIG_INPUT_KEYS.has(key))) {
    throw new Error("Launcher config accepts only smedcBaseUrl.");
  }
}

function normalizeSmedcBaseUrl(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("SMEDC base URL is required.");
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("SMEDC base URL must be an http(s) URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("SMEDC base URL must be a canonical HTTPS origin.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SMEDC base URL must not include credentials, query, or hash.");
  }

  if (!/^\/$/.test(url.pathname.replace(/\/+$/, "/"))) {
    throw new Error("SMEDC base URL must be a canonical HTTPS origin.");
  }

  return url.origin;
}
