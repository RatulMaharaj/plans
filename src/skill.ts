import { api } from "./api";
import skillText from "../skills/plans/SKILL.md?raw";

/**
 * The conventions ship inside the bundle, imported at build time from the one
 * canonical file in this repo — the app can never drift from it.
 *
 * What differs between agents is only *where* a copy goes. The text is the same
 * text whoever is reading it, so there is one file here and a table of paths in
 * `discover.rs` saying which agent looks where. "Install" used to write Claude
 * Code's path and only Claude Code's, which meant that for three of the four
 * agents the button was a no-op with a reassuring label.
 */

/** Claude Code's, still — now one destination among several rather than the only one. */
export const SKILL_PATH = ".claude/skills/plans/SKILL.md";

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
 * the text that happens to be in it.
 */
const BEGIN = "<!-- plans:begin -->";
const END = "<!-- plans:end -->";
const SECTION = `${BEGIN}\n${skillText.trim()}\n${END}\n`;

/** The managed section, put into a file that may already say other things. */
function merge(existing: string | null): string {
  if (existing === null || !existing.trim()) return SECTION;
  const from = existing.indexOf(BEGIN);
  const to = existing.indexOf(END);
  if (from !== -1 && to > from) {
    return existing.slice(0, from) + SECTION.trimEnd() + existing.slice(to + END.length);
  }
  // Nothing of ours in there yet: append, and leave every word of theirs alone.
  return `${existing.replace(/\s*$/, "")}\n\n${SECTION}`;
}

/** What the file at `path` should contain once the conventions are installed. */
function wanted(path: string, existing: string | null): string {
  return appOwned(path) ? skillText : merge(existing);
}

async function read(repo: string, path: string): Promise<string | null> {
  try {
    return (await api.readPlan(repo, path)).content;
  } catch {
    return null;
  }
}

/**
 * What `installConventions` would do, without doing it — so a button can say
 * "Install", "Update" or nothing at all rather than offering the same press to
 * every repository regardless of what is already there.
 *
 * `missing` when any destination has no copy at all, `stale` when every one
 * exists but at least one differs. Answered across all the paths at once
 * because the button is one button: a repository where Claude Code's copy is
 * current and Codex's is absent has not had the conventions installed.
 */
export async function skillState(repo: string, paths: string[]): Promise<SkillState> {
  const wants = paths.length ? paths : [SKILL_PATH];
  let stale = false;
  for (const path of wants) {
    const existing = await read(repo, path);
    if (existing === null) return "missing";
    if (existing !== wanted(path, existing)) stale = true;
  }
  return stale ? "stale" : "current";
}

/**
 * Write the bundled conventions everywhere the agents on this machine look.
 *
 * A file the app owns is replaced; a file the repository owns keeps everything
 * in it and has only the fenced section rewritten. Either way the change lands
 * in git as a reviewable, revertable diff rather than a silent divergence —
 * which is the reason overwriting is acceptable at all.
 */
export async function installConventions(
  repo: string,
  paths: string[],
): Promise<SkillInstall> {
  const wants = paths.length ? paths : [SKILL_PATH];
  let touched = false;
  let made = false;
  for (const path of wants) {
    const existing = await read(repo, path);
    const next = wanted(path, existing);
    if (existing === next) continue;
    await api.writePlan(repo, path, next);
    touched = true;
    if (existing === null) made = true;
  }
  if (!touched) return "current";
  return made ? "installed" : "updated";
}
