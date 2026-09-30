export interface LauncherRuntimeConfig {
  serviceUrl: string;
  transport: "stdio";
  credentialProfile?: string;
}

export interface LauncherRuntimeConfigInput {
  smedcBaseUrl: string;
  credentialProfile?: string;
}

type LauncherRuntimeEnv = Partial<
  Record<"SMEDC_BASE_URL" | "SMEDC_CREDENTIAL_PROFILE", string | undefined>
>;

const CONFIG_INPUT_KEYS = new Set(["smedcBaseUrl", "credentialProfile"]);

export function createLauncherRuntimeConfig(
  input: LauncherRuntimeConfigInput
): LauncherRuntimeConfig {
  assertConfigInputKeys(input);

  return {
    serviceUrl: normalizeSmedcBaseUrl(input.smedcBaseUrl),
    transport: "stdio",
    credentialProfile: validateCredentialProfile(input.credentialProfile)
  };
}

export function loadLauncherRuntimeConfig(
  env: LauncherRuntimeEnv = process.env
): LauncherRuntimeConfig {
  const smedcBaseUrl = env.SMEDC_BASE_URL;

  if (!smedcBaseUrl) {
    throw new Error("SMEDC_BASE_URL is required.");
  }

  return createLauncherRuntimeConfig({
    smedcBaseUrl,
    credentialProfile: env.SMEDC_CREDENTIAL_PROFILE
  });
}

function assertConfigInputKeys(input: LauncherRuntimeConfigInput): void {
  const keys = Object.keys(input);

  if (keys.some((key) => !CONFIG_INPUT_KEYS.has(key))) {
    throw new Error("Launcher config accepts only smedcBaseUrl and credentialProfile.");
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

/** A local credential namespace, never an organization or authorization selector. */
export function validateCredentialProfile(value: unknown = "default"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error("SMEDC credential profile must match [A-Za-z0-9_-]{1,64}.");
  }
  return value;
}
