import {
  parseRuntimeReadinessConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "@enterprise-hub/domain";

export function parseApiRetrievalRuntimeConfig(
  env: RuntimeEnv = process.env
): RuntimeReadinessConfig {
  return parseRuntimeReadinessConfig(env);
}
