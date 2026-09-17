import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { EmployeeRole, PrismaClient, SkillEntryStatus } from "@prisma/client";

const adapter = new PrismaMariaDb(process.env["DATABASE_URL"] ?? "");
const prisma = new PrismaClient({ adapter });

const org = {
  id: "default-org",
  name: "SMEDC QA 示例餐饮管理有限公司"
};

const employees = [
  {
    id: "emp_admin",
    email: "admin@example.com",
    displayName: "Admin",
    role: EmployeeRole.admin,
    clearance: 3
  },
  {
    id: "emp_baoli_employee",
    email: "baoli.employee@example.com",
    displayName: "Baoli Employee",
    role: EmployeeRole.employee,
    clearance: 1
  },
  {
    id: "emp_suzhou_employee",
    email: "suzhou.employee@example.com",
    displayName: "Suzhou Employee",
    role: EmployeeRole.employee,
    clearance: 2
  },
  {
    id: "emp_lijie",
    email: "lijie@example.com",
    displayName: "Li Jie",
    role: EmployeeRole.employee,
    clearance: 0
  }
] as const;

const skillEntries = [
  {
    id: "skill_weekly_store_report",
    name: "weekly-store-report",
    description: "门店周报 skill，帮助员工智能体基于已授权资料生成周报草稿。",
    version: "1.0.0",
    category: "reporting",
    inputRequirements: ["已授权的 active 经营数据", "目标周"],
    installInstructions: "Install the approved weekly-store-report skill in the employee agent.",
    examplePrompts: ["用保利店上周经营数据生成周报草稿"],
    status: SkillEntryStatus.approved
  },
  {
    id: "skill_menu_gross_margin_analysis",
    name: "menu-gross-margin-analysis",
    description: "菜单毛利分析 skill，帮助员工智能体分析菜品毛利和菜单结构。",
    version: "1.0.0",
    category: "menu-analysis",
    inputRequirements: ["已授权的菜单数据", "菜品成本数据", "销售明细"],
    installInstructions:
      "Install the approved menu-gross-margin-analysis skill in the employee agent.",
    examplePrompts: ["分析最近三个月菜单毛利，找出需要调整的菜品"],
    status: SkillEntryStatus.approved
  }
] as const;

async function main() {
  await prisma.organization.upsert({
    where: { id: org.id },
    create: org,
    update: { name: org.name }
  });

  for (const employee of employees) {
    await prisma.employee.upsert({
      where: { email: employee.email },
      create: {
        id: employee.id,
        orgId: org.id,
        email: employee.email,
        displayName: employee.displayName,
        role: employee.role,
        clearance: employee.clearance,
        disabled: false
      },
      update: {
        displayName: employee.displayName,
        role: employee.role,
        clearance: employee.clearance,
        disabled: false
      }
    });

    await prisma.loginIdentity.upsert({
      where: { normalizedEmail: employee.email },
      create: {
        id: `identity_${employee.id}`,
        orgId: org.id,
        employeeId: employee.id,
        normalizedEmail: employee.email,
        passwordHash: null
      },
      update: {
        orgId: org.id,
        employeeId: employee.id,
        disabled: false
      }
    });
  }

  for (const skill of skillEntries) {
    await prisma.skillEntry.upsert({
      where: {
        orgId_name_version: {
          orgId: org.id,
          name: skill.name,
          version: skill.version
        }
      },
      create: {
        id: skill.id,
        orgId: org.id,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        category: skill.category,
        inputRequirements: [...skill.inputRequirements],
        installInstructions: skill.installInstructions,
        examplePrompts: [...skill.examplePrompts],
        status: skill.status
      },
      update: {
        description: skill.description,
        category: skill.category,
        inputRequirements: [...skill.inputRequirements],
        installInstructions: skill.installInstructions,
        examplePrompts: [...skill.examplePrompts],
        status: skill.status
      }
    });
  }

  const [organizationCount, employeeCount, skillEntryCount] = await Promise.all([
    prisma.organization.count(),
    prisma.employee.count({ where: { orgId: org.id } }),
    prisma.skillEntry.count({ where: { orgId: org.id } })
  ]);

  console.log(
    `Seed complete: organizations=${organizationCount}, employees=${employeeCount}, skill_entries=${skillEntryCount}`
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
