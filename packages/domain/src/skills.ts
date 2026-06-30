export const SKILL_ENTRY_STATUSES = ["approved", "disabled"] as const;

export type SkillEntryStatusName = (typeof SKILL_ENTRY_STATUSES)[number];
