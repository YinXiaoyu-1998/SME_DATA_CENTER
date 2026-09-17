import {
  parseRuntimeReadinessConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "@smedc/domain";

export function parseApiRetrievalRuntimeConfig(
  env: RuntimeEnv = process.env
): RuntimeReadinessConfig {
  return parseRuntimeReadinessConfig(env);
}
