import { api } from "./api";
import skillText from "../skills/plans/SKILL.md?raw";

/**
 * The agent skill ships inside the bundle, imported at build time from the
 * one canonical file in this repo — the app can never drift from it.
 * It installs where Claude Code discovers skills.
 */
export const SKILL_PATH = ".claude/skills/plans/SKILL.md";

export type SkillInstall = "installed" | "updated" | "current";

/** Whether a repository has the skill, and whether it is the bundled one. */
export type SkillState = "missing" | "stale" | "current";

/**
 * What `installSkill` would do, without doing it — so a button can say
 * "Install", "Update" or nothing at all rather than offering the same press
 * to every repository regardless of what is already there.
 */
export async function skillState(repo: string): Promise<SkillState> {
  try {
    const { content } = await api.readPlan(repo, SKILL_PATH);
    return content === skillText ? "current" : "stale";
  } catch {
    return "missing";
  }
}

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
