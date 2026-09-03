import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { databaseErrorDetails } from "./retry.js";

export function createDatabaseAdapter(databaseUrl: string): PrismaMariaDb {
  return new PrismaMariaDb(databaseUrl, {
    // Binary PREPARE/EXECUTE/CLOSE with overlapping relation reads produces
    // MySQL 1835 on the staging RDS proxy. The driver still binds/escapes values.
    useTextProtocol: true,
    onConnectionError(error) {
      console.error(
        JSON.stringify({
          event: "database_connection_error",
          time: new Date().toISOString(),
          ...databaseErrorDetails(error),
          fatal: error.fatal
        })
      );
    }
  });
}
