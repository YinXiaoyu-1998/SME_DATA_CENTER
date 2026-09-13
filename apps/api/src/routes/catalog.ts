import type { FastifyInstance } from "fastify";
import type { SkillDirectoryEntry, SkillDirectoryRepository } from "../skills.js";
import type { RequestAuth } from "../request-auth.js";

interface SkillListQuery {
  q?: string;
  category?: string;
}

function skillDirectoryResponse(skill: SkillDirectoryEntry) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    category: skill.category,
    inputRequirements: skill.inputRequirements,
    installInstructions: skill.installInstructions,
    examplePrompts: skill.examplePrompts,
    status: skill.status
  };
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    skills: () => SkillDirectoryRepository;
  }
): void {
  app.get<{ Querystring: SkillListQuery }>("/skills", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);
    const query = request.query;
    const skillEntries = await dependencies.skills().listApprovedSkills({
      orgId: employee.orgId,
      q: query.q?.trim() || null,
      category: query.category?.trim() || null
    });

    return {
      skills: skillEntries.map(skillDirectoryResponse)
    };
  });
}
