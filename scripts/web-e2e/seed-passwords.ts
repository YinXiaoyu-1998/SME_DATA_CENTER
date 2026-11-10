/**
 * 给本地种子账号设置确定性密码，供浏览器端到端使用。
 *
 * 不经过邮件或 operator CLI 的交互：直接签发一次性设置凭据，再用 AuthCore
 * 兑换并消费会话，走的是与真实设密码流程完全相同的代码路径。
 */
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { randomBytes } from "node:crypto";
import { AuthCore, type AuthRequestAudit } from "../../apps/api/src/auth/auth-core.js";
import { hashOpaqueSecret } from "../../apps/api/src/auth/primitives.js";
import { createPrismaAuthCoreRepository } from "../../apps/api/src/auth/prisma-auth-repository.js";
import { createPrismaAuthOperatorRepository } from "../../apps/api/src/auth/prisma-auth-operator-repository.js";

export const E2E_PASSWORD = "smedc-e2e-password-2026";

/** 三个账号覆盖：同组织管理员、同组织普通员工、另一组织员工。 */
export const E2E_ACCOUNTS = [
  { userAccountId: "emp_admin", email: "admin@example.com" },
  { userAccountId: "emp_baoli_employee", email: "baoli.employee@example.com" },
  { userAccountId: "emp_suzhou_employee", email: "suzhou.employee@example.com" }
] as const;

const audit: AuthRequestAudit = {
  requestId: "web-e2e-seed",
  sourceIp: "127.0.0.1",
  launcherVersion: null
};

export async function seedPasswords(databaseUrl: string): Promise<void> {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  try {
    const operator = createPrismaAuthOperatorRepository(prisma);
    const core = new AuthCore(createPrismaAuthCoreRepository(prisma));
    const now = new Date();

    for (const account of E2E_ACCOUNTS) {
      const secret = `eh_ps_${randomBytes(24).toString("base64url")}`;
      const reset = await operator.resetPassword({
        userAccountId: account.userAccountId,
        grantTokenHash: hashOpaqueSecret(secret),
        grantExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        now
      });
      if (!reset) {
        throw new Error(`employee ${account.userAccountId} has no active local-password identity`);
      }
      const session = await core.exchangePasswordSetupGrant(secret, audit);
      if (!session) {
        throw new Error(`could not exchange the setup grant for ${account.userAccountId}`);
      }
      const saved = await core.consumePasswordSetupSession(
        session.sessionSecret,
        E2E_PASSWORD,
        audit
      );
      if (!saved) {
        throw new Error(`could not set the password for ${account.userAccountId}`);
      }
      process.stdout.write(`password set: ${account.email}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const databaseUrl = process.env["DATABASE_URL"];
if (process.argv[1]?.endsWith("seed-passwords.ts")) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  await seedPasswords(databaseUrl);
}
