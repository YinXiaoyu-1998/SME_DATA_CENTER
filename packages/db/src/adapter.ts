import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { databaseErrorDetails } from "./retry.js";

type RawDriver = Awaited<ReturnType<PrismaMariaDb["connect"]>>;
type Driver = Pick<RawDriver, keyof RawDriver>;
type SharedPool = { driver: Promise<Driver>; owners: number };
const pools = new Map<string, SharedPool>();

/** Share one pool per process/configuration; each Prisma client owns an independent lease. */
export function createDatabaseAdapter(
  databaseUrl: string
): Pick<PrismaMariaDb, "provider" | "adapterName"> & { connect(): Promise<Driver> } {
  let key = databaseUrl;
  try {
    const url = new URL(databaseUrl);
    for (const [name, value] of Object.entries({
      connectionLimit: "10",
      minimumIdle: "0",
      idleTimeout: "60"
    })) {
      if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    }
    url.searchParams.sort();
    key = url.toString();
  } catch {
    // Preserve the driver's deferred, credential-free validation when connecting.
  }
  const factory = new PrismaMariaDb(key, {
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
  return {
    provider: factory.provider,
    adapterName: factory.adapterName,
    async connect(): Promise<Driver> {
      let pool = pools.get(key);
      if (!pool) {
        pool = { driver: factory.connect(), owners: 0 };
        pools.set(key, pool);
      }
      const owned = pool;
      owned.owners++;
      let driver: Driver;
      try {
        driver = await owned.driver;
      } catch (error) {
        if (--owned.owners === 0 && pools.get(key) === owned) pools.delete(key);
        throw error;
      }
      let release: Promise<void> | undefined;
      return {
        provider: driver.provider,
        adapterName: driver.adapterName,
        queryRaw: driver.queryRaw.bind(driver),
        executeRaw: driver.executeRaw.bind(driver),
        executeScript: driver.executeScript.bind(driver),
        getConnectionInfo: driver.getConnectionInfo.bind(driver),
        startTransaction: driver.startTransaction.bind(driver),
        underlyingDriver: driver.underlyingDriver.bind(driver),
        dispose(): Promise<void> {
          return (release ??= (async () => {
            if (--owned.owners === 0) {
              // A new client may acquire a fresh pool while this one drains.
              if (pools.get(key) === owned) pools.delete(key);
              await driver.dispose();
            }
          })());
        }
      };
    }
  };
}
