import { api } from "./api";
import skillText from "../skills/plans/SKILL.md?raw";

/**
 * The agent skill ships inside the bundle, imported at build time from the
 * one canonical file in this repo — the app can never drift from it.
 * It installs where Claude Code discovers skills.
 */
export const SKILL_PATH = ".claude/skills/plans/SKILL.md";

export type SkillInstall = "installed" | "updated" | "current";

/**
 * Write the bundled skill into a repository. An existing copy that differs is
 * overwritten — the repo is git, so the change lands as a reviewable,
 * revertable diff rather than a silent divergence.
 */
export async function installSkill(repo: string): Promise<SkillInstall> {
  let existing: string | null = null;
  try {
    existing = (await api.readPlan(repo, SKILL_PATH)).content;
  } catch {
    // Not there yet — a plain install.
  }
  if (existing === skillText) return "current";
  await api.writePlan(repo, SKILL_PATH, skillText);
  return existing === null ? "installed" : "updated";
}
