import {
  parseRuntimeReadinessConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "@enterprise-hub/domain";

export function parseWorkerRetrievalRuntimeConfig(
  env: RuntimeEnv = process.env
): RuntimeReadinessConfig {
  return parseRuntimeReadinessConfig(env);
}
