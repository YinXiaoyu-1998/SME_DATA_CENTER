import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { Prisma, PrismaClient, SkillEntryStatus } from "@prisma/client";
import type { SkillEntryStatusName } from "@enterprise-hub/domain";

export interface SkillDirectoryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  inputRequirements: string[];
  installInstructions: string;
  examplePrompts: string[];
  status: SkillEntryStatusName;
}

export interface ListApprovedSkillsInput {
  orgId: string;
  q: string | null;
  category: string | null;
}

export interface SkillDirectoryRepository {
  listApprovedSkills(input: ListApprovedSkillsInput): Promise<SkillDirectoryEntry[]>;
  disconnect?(): Promise<void>;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the API with the Prisma skill repository.");
  }

  return databaseUrl;
}

export function createPrismaSkillDirectoryRepository(
  databaseUrl = requireDatabaseUrl()
): SkillDirectoryRepository {
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async listApprovedSkills(input) {
      const skills = await prisma.skillEntry.findMany({
        where: {
          orgId: input.orgId,
          status: SkillEntryStatus.approved,
          ...(input.category ? { category: input.category } : {})
        },
        orderBy: [{ category: "asc" }, { name: "asc" }, { version: "desc" }]
      });

      return filterKeywordMatches(skills.map(toSkillDirectoryEntry), input.q);
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function filterKeywordMatches(skills: SkillDirectoryEntry[], q: string | null) {
  const keyword = q?.trim().toLowerCase();

  if (!keyword) {
    return skills;
  }

  return skills.filter((skill) =>
    [
      skill.name,
      skill.description,
      skill.category,
      ...skill.inputRequirements,
      skill.installInstructions,
      ...skill.examplePrompts
    ]
      .join("\n")
      .toLowerCase()
      .includes(keyword)
  );
}

function toStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function toSkillDirectoryEntry(skill: {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  inputRequirements: Prisma.JsonValue;
  installInstructions: string;
  examplePrompts: Prisma.JsonValue;
  status: SkillEntryStatus;
}): SkillDirectoryEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    category: skill.category,
    inputRequirements: toStringArray(skill.inputRequirements),
    installInstructions: skill.installInstructions,
    examplePrompts: toStringArray(skill.examplePrompts),
    status: skill.status
  };
}
