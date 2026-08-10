import type { SkillDirectoryEntry, SkillDirectoryRepository } from "../skills.js";

export function createSkillRepository(entries: SkillDirectoryEntry[]): SkillDirectoryRepository {
  return {
    async listApprovedSkills(input) {
      const q = input.q?.toLowerCase() ?? null;
      return entries.filter((entry) => {
        if (entry.status !== "approved") {
          return false;
        }

        if (input.category && entry.category !== input.category) {
          return false;
        }

        if (!q) {
          return true;
        }

        return [
          entry.name,
          entry.description,
          entry.category,
          ...entry.inputRequirements,
          entry.installInstructions,
          ...entry.examplePrompts
        ]
          .join("\n")
          .toLowerCase()
          .includes(q);
      });
    }
  };
}

export const skillEntries: SkillDirectoryEntry[] = [
  {
    id: "skill_weekly_store_report",
    name: "weekly-store-report",
    description: "门店周报 skill，帮助员工智能体基于已授权资料生成周报草稿。",
    version: "1.0.0",
    category: "reporting",
    inputRequirements: ["已授权的 active 经营数据", "门店标签", "目标周"],
    installInstructions: "Install the approved weekly-store-report skill in the employee agent.",
    examplePrompts: ["用保利店上周经营数据生成周报草稿"],
    status: "approved"
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
    status: "approved"
  },
  {
    id: "skill_disabled",
    name: "disabled-skill",
    description: "Disabled internal experiment.",
    version: "0.1.0",
    category: "internal",
    inputRequirements: [],
    installInstructions: "Do not install.",
    examplePrompts: [],
    status: "disabled"
  }
];
