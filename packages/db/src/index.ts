export const dbWorkspaceName = "@smedc/db";
export { createDatabaseAdapter } from "./adapter.js";
export {
  databaseErrorDetails,
  retryIdempotentDatabaseOperation,
  type DatabaseRetryEvent
} from "./retry.js";
export * from "./structured-partitions.js";
