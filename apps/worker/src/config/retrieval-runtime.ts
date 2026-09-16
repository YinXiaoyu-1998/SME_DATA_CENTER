import {
  parseRuntimeReadinessConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "@smedc/domain";

export function parseWorkerRetrievalRuntimeConfig(
  env: RuntimeEnv = process.env
): RuntimeReadinessConfig {
  return parseRuntimeReadinessConfig(env);
}
