import { api } from "./api";
import plansText from "../skills/plans/SKILL.md?raw";
import reviewText from "../skills/review/SKILL.md?raw";
import prText from "../skills/pr/SKILL.md?raw";
import factoryText from "../skills/factory/SKILL.md?raw";
import writingText from "../skills/writing/SKILL.md?raw";
import settingsText from "../skills/settings/SKILL.md?raw";

/**
 * The conventions ship inside the bundle, imported at build time from the
 * canonical files in this repo — the app can never drift from them.
 *
 * What differs between agents is only *where* a copy goes. The text is the same
 * text whoever is reading it, so there is a table of skills here and a table of
 * paths in `discover.rs` saying which agent looks where. "Install" used to
 * write Claude Code's path and only Claude Code's, which meant that for three
 * of the four agents the button was a no-op with a reassuring label.
 */

export type BundledSkill = {
  /** The skill's directory name — also its palette-facing identity. */
  name: string;
  label: string;
  text: string;
  /**
   * The fence around this skill's section in a repository-owned file. The
   * plans section keeps the bare spelling so existing installs still match;
   * later skills carry their name in the marker.
   */
  begin: string;
  end: string;
  /** Where Claude Code reads this skill — its own file, one per skill. */
  claudePath: string;
};

export const SKILLS: BundledSkill[] = [
  {
    name: "plans",
    label: "plans skill",
    text: plansText,
    begin: "<!-- plans:begin -->",
    end: "<!-- plans:end -->",
    claudePath: ".claude/skills/plans/SKILL.md",
  },
  {
    name: "review",
    label: "review skill",
    text: reviewText,
    begin: "<!-- plans:begin review -->",
    end: "<!-- plans:end review -->",
    claudePath: ".claude/skills/review/SKILL.md",
  },
  {
    name: "pr",
    label: "pr skill",
    text: prText,
    begin: "<!-- plans:begin pr -->",
    end: "<!-- plans:end pr -->",
    claudePath: ".claude/skills/pr/SKILL.md",
  },
  {
    name: "factory",
    label: "factory skill",
    text: factoryText,
    begin: "<!-- plans:begin factory -->",
    end: "<!-- plans:end factory -->",
    claudePath: ".claude/skills/factory/SKILL.md",
  },
  {
    name: "writing",
    label: "writing skill",
    text: writingText,
    begin: "<!-- plans:begin writing -->",
    end: "<!-- plans:end writing -->",
    claudePath: ".claude/skills/writing/SKILL.md",
  },
  {
    name: "settings",
    label: "settings skill",
    text: settingsText,
    begin: "<!-- plans:begin settings -->",
    end: "<!-- plans:end settings -->",
    claudePath: ".claude/skills/settings/SKILL.md",
  },
];

/** Claude Code's plans path, still — the default destination when no agent is found. */
export const SKILL_PATH = SKILLS[0].claudePath;

export type SkillInstall = "installed" | "updated" | "current";

/** Whether a repository has the conventions, and whether they are the bundled ones. */
export type SkillState = "missing" | "stale" | "current";

/**
 * Whose file is this?
 *
 * A path inside a tool's own dotted directory exists because the tool exists;
 * nothing else writes there, so the app owns it and replaces it outright. A
 * file at the root of the repository — `AGENTS.md`, `GEMINI.md` — belongs to
 * the repository. It may have been written by a person, may say things this app
 * knows nothing about, and overwriting it would throw away work that has
 * nothing to do with us.
 */
function appOwned(path: string): boolean {
  return path.startsWith(".");
}

/*
 * The fence around the part the app maintains.
 *
 * HTML comments because these are markdown files an agent reads as prose: the
 * markers have to be invisible when rendered and obvious when edited. Matching
 * on the markers rather than on the content means a section someone has since
 * reworded is still found and still replaced — the app owns the region, not
 * the text that happens to be in it. The bare markers cannot match the named
 * ones: `<!-- plans:begin -->` includes its closing ` -->`, which
 * `<!-- plans:begin review -->` does not contain.
 */
function section(skill: BundledSkill): string {
  return `${skill.begin}\n${skill.text.trim()}\n${skill.end}\n`;
}

/** One skill's managed section, put into a file that may already say other things. */
function merge(existing: string | null, skill: BundledSkill): string {
  const wanted = section(skill);
  if (existing === null || !existing.trim()) return wanted;
  const from = existing.indexOf(skill.begin);
  const to = existing.indexOf(skill.end);
  if (from !== -1 && to > from) {
    return existing.slice(0, from) + wanted.trimEnd() + existing.slice(to + skill.end.length);
  }
  // Nothing of this skill's in there yet: append, and leave every word else alone.
  return `${existing.replace(/\s*$/, "")}\n\n${wanted}`;
}

/**
 * Every file that installing writes, given the paths the agents look at.
 *
 * An app-owned path is Claude Code's per-skill file: one destination per
 * bundled skill, each holding that skill alone. A repository-owned file
 * (`AGENTS.md`, `GEMINI.md`) holds every skill, each in its own fenced
 * section — one file, several fences, a single block of our footprint.
 */
function targets(paths: string[]): { path: string; skills: BundledSkill[] }[] {
  const wants = paths.length ? paths : [SKILL_PATH];
  const out: { path: string; skills: BundledSkill[] }[] = [];
  const seen = new Set<string>();
  for (const path of wants) {
    if (appOwned(path)) {
      // The table in discover.rs names the plans file; the review file sits
      // beside it, in the same skills directory.
      for (const skill of SKILLS) {
        const dest = path.replace(/\/plans\/SKILL\.md$/, `/${skill.name}/SKILL.md`);
        if (seen.has(dest)) continue;
        seen.add(dest);
        out.push({ path: dest, skills: [skill] });
      }
    } else {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, skills: SKILLS });
    }
  }
  return out;
}

/** What the file at `path` should contain once the conventions are installed. */
function wanted(target: { path: string; skills: BundledSkill[] }, existing: string | null): string {
  if (appOwned(target.path)) return target.skills[0].text;
  return target.skills.reduce((acc, skill) => merge(acc, skill), existing) as string;
}

async function read(repo: string, path: string): Promise<string | null> {
  try {
    return (await api.readPlan(repo, path)).content;
  } catch {
    return null;
  }
}

/**
 * Where a skill actually lives in this repository, if anywhere.
 *
 * The palette's "Open the … skill" used to assume Claude Code's per-skill
 * path, which is only one of the places installing writes — a repository
 * whose conventions live in `AGENTS.md` had a command that opened nothing.
 * This walks the same targets installing would and returns the first file
 * that both carries the skill and exists.
 */
export async function skillFileFor(
  repo: string,
  paths: string[],
  name: string,
): Promise<string | null> {
  for (const target of targets(paths)) {
    if (!target.skills.some((s) => s.name === name)) continue;
    if ((await read(repo, target.path)) !== null) return target.path;
  }
  return null;
}

/**
 * What `installConventions` would do, without doing it — so a button can say
 * "Install", "Update" or nothing at all rather than offering the same press to
 * every repository regardless of what is already there.
 *
 * `missing` when any destination has no copy at all, `stale` when every one
 * exists but at least one differs. Answered across all the skills and paths at
 * once because the button is one button: a repository with the plans
 * conventions and no review skill has not had the conventions installed.
 */
export async function skillState(repo: string, paths: string[]): Promise<SkillState> {
  let stale = false;
  for (const target of targets(paths)) {
    const existing = await read(repo, target.path);
    if (existing === null) return "missing";
    if (existing !== wanted(target, existing)) stale = true;
  }
  return stale ? "stale" : "current";
}

/**
 * Write the bundled conventions everywhere the agents on this machine look.
 *
 * A file the app owns is replaced; a file the repository owns keeps everything
 * in it and has only the fenced sections rewritten. Either way the change lands
 * in git as a reviewable, revertable diff rather than a silent divergence —
 * which is the reason overwriting is acceptable at all.
 */
export async function installConventions(
  repo: string,
  paths: string[],
): Promise<SkillInstall> {
  let touched = false;
  let made = false;
  for (const target of targets(paths)) {
    const existing = await read(repo, target.path);
    const next = wanted(target, existing);
    if (existing === next) continue;
    await api.writePlan(repo, target.path, next);
    touched = true;
    if (existing === null) made = true;
  }
  if (!touched) return "current";
  return made ? "installed" : "updated";
}
