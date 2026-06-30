import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { EmployeeRole, LabelType, PrismaClient, SkillEntryStatus } from "@prisma/client";

const adapter = new PrismaMariaDb(process.env["DATABASE_URL"] ?? "");
const prisma = new PrismaClient({ adapter });

const org = {
  id: "default-org",
  name: "Default Organization"
};

const employees = [
  {
    id: "emp_admin",
    email: "admin@example.com",
    displayName: "Admin",
    role: EmployeeRole.admin,
    personalLabelKey: "person:admin",
    labelKeys: ["all_staff", "store:baoli", "store:suzhou", "person:admin"]
  },
  {
    id: "emp_baoli_manager",
    email: "baoli.manager@example.com",
    displayName: "Baoli Manager",
    role: EmployeeRole.manager,
    personalLabelKey: "person:baoli.manager",
    labelKeys: ["all_staff", "store:baoli", "person:baoli.manager"]
  },
  {
    id: "emp_suzhou_manager",
    email: "suzhou.manager@example.com",
    displayName: "Suzhou Manager",
    role: EmployeeRole.manager,
    personalLabelKey: "person:suzhou.manager",
    labelKeys: ["all_staff", "store:suzhou", "person:suzhou.manager"]
  },
  {
    id: "emp_lijie",
    email: "lijie@example.com",
    displayName: "Li Jie",
    role: EmployeeRole.employee,
    personalLabelKey: "person:lijie",
    labelKeys: ["all_staff", "person:lijie"]
  }
] as const;

const sharedLabels = [
  {
    id: "label_all_staff",
    key: "all_staff",
    name: "All Staff",
    type: LabelType.all_staff
  },
  {
    id: "label_store_baoli",
    key: "store:baoli",
    name: "Baoli Store",
    type: LabelType.store
  },
  {
    id: "label_store_suzhou",
    key: "store:suzhou",
    name: "Suzhou Store",
    type: LabelType.store
  }
] as const;

const personalLabels = employees.map((employee) => ({
  id: `label_${employee.id.replace("emp_", "person_")}`,
  key: employee.personalLabelKey,
  name: `${employee.displayName} Personal`,
  type: LabelType.personal
}));

const skillEntries = [
  {
    id: "skill_weekly_store_report",
    name: "weekly-store-report",
    description: "门店周报 skill，帮助员工智能体基于已授权资料生成周报草稿。",
    version: "1.0.0",
    category: "reporting",
    inputRequirements: ["已授权的 active 经营数据", "门店标签", "目标周"],
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

  for (const label of [...sharedLabels, ...personalLabels]) {
    await prisma.label.upsert({
      where: {
        orgId_key: {
          orgId: org.id,
          key: label.key
        }
      },
      create: {
        id: label.id,
        orgId: org.id,
        key: label.key,
        name: label.name,
        type: label.type
      },
      update: {
        name: label.name,
        type: label.type
      }
    });
  }

  for (const employee of employees) {
    await prisma.employee.upsert({
      where: { email: employee.email },
      create: {
        id: employee.id,
        orgId: org.id,
        email: employee.email,
        displayName: employee.displayName,
        role: employee.role,
        disabled: false
      },
      update: {
        displayName: employee.displayName,
        role: employee.role,
        disabled: false
      }
    });

    const assignedLabels = await prisma.label.findMany({
      where: {
        orgId: org.id,
        key: { in: [...employee.labelKeys] }
      },
      select: { id: true }
    });

    for (const label of assignedLabels) {
      await prisma.employeeLabel.upsert({
        where: {
          employeeId_labelId: {
            employeeId: employee.id,
            labelId: label.id
          }
        },
        create: {
          employeeId: employee.id,
          labelId: label.id
        },
        update: {}
      });
    }
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

  const [organizationCount, employeeCount, labelCount, employeeLabelCount, skillEntryCount] =
    await Promise.all([
      prisma.organization.count(),
      prisma.employee.count({ where: { orgId: org.id } }),
      prisma.label.count({ where: { orgId: org.id } }),
      prisma.employeeLabel.count(),
      prisma.skillEntry.count({ where: { orgId: org.id } })
    ]);

  console.log(
    `Seed complete: organizations=${organizationCount}, employees=${employeeCount}, labels=${labelCount}, employee_labels=${employeeLabelCount}, skill_entries=${skillEntryCount}`
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
