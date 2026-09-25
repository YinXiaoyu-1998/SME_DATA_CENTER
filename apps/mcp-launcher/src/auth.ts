export interface SecureCredentialStore {
  get(): Promise<string | null>;
  set(credential: string): Promise<void>;
  delete(): Promise<void>;
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

function isSecretKey(key: string): boolean {
  return /(?:token|authorization|cookie|password|credential|code|secret)/i.test(key);
}
