import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { EmployeeRole, LabelType, PrismaClient } from "@prisma/client";

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

  const [organizationCount, employeeCount, labelCount, employeeLabelCount] = await Promise.all([
    prisma.organization.count(),
    prisma.employee.count({ where: { orgId: org.id } }),
    prisma.label.count({ where: { orgId: org.id } }),
    prisma.employeeLabel.count()
  ]);

  console.log(
    `Seed complete: organizations=${organizationCount}, employees=${employeeCount}, labels=${labelCount}, employee_labels=${employeeLabelCount}`
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
