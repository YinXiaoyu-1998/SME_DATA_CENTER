/**
 * The immutable staging runtime identity used by operator tooling that must
 * refuse to touch any other database. Loopback Qdrant access is only trusted
 * when the paired DATABASE_URL provably points at this exact private RDS.
 */
export const STAGING_RDS_HOST = "rm-2zesq01oq9opworc7.mysql.rds.aliyuncs.com";
export const STAGING_RDS_DATABASE = "enterprise_hub";
export const STAGING_RDS_USER = "enterprise_hub_app";

export function isStagingRuntimeDatabaseUrl(databaseUrl: string): boolean {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\/+/, "");
  const username = decodeURIComponent(parsed.username);
  const port = Number(parsed.port || "3306");
  return (
    parsed.hostname === STAGING_RDS_HOST &&
    databaseName === STAGING_RDS_DATABASE &&
    username === STAGING_RDS_USER &&
    port === 3306
  );
}
