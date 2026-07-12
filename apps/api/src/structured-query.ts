import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import type { StructuredCompiledQuery } from "@enterprise-hub/domain";

export interface ExecuteStructuredQueryResult {
  rows: Array<Record<string, unknown>>;
  hasMore: boolean;
}

export interface StructuredQueryRepository {
  execute(compiled: StructuredCompiledQuery): Promise<ExecuteStructuredQueryResult>;
  disconnect?(): Promise<void>;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma structured query repository."
    );
  }

  return databaseUrl;
}

export function createPrismaStructuredQueryRepository(
  databaseUrl = requireDatabaseUrl()
): StructuredQueryRepository {
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async execute(compiled) {
      const params = [...compiled.params];
      const limitParamIndex = params.length - 2;
      params[limitParamIndex] = compiled.limit + 1;
      const rows = (await prisma.$queryRawUnsafe(compiled.sql, ...params)) as Array<
        Record<string, unknown>
      >;
      const visibleRows = rows.slice(0, compiled.limit);

      return {
        rows: visibleRows,
        hasMore: rows.length > compiled.limit
      };
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}
