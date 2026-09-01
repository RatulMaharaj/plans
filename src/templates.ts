/**
 * What a new file is made of.
 *
 * There used to be exactly one answer, and it lived in Rust: `create_plan`
 * wrote `---\nstatus: …\n---\n# Title\n\n` and nothing else could be made. A
 * daily note, a meeting record, a bug report — each of them was a change to the
 * backend. So the shape of a new file moved out here, into files the reader
 * owns.
 *
 * A template is a markdown file. Its frontmatter is its configuration and its
 * body is the body of the file it stamps out, which means what you see when you
 * open one is what you get when you use it — and it is openable and editable in
 * this app, because this app edits markdown. They live in `~/.plans/templates/`,
 * beside the skills, with the ownership reversed: the skills are the app's and
 * are rewritten on every launch; the templates are yours and are seeded once.
 */
import { api } from "./api";
import { splitFrontmatter } from "./matter";
import planText from "../templates/plan.md?raw";
import dailyText from "../templates/daily-note.md?raw";

export type Template = {
  /** The file it came from — `plan.md`. Its identity, since names may repeat. */
  file: string;
  /** What the palette and the tree's menu call it. */
  name: string;
  /** The filename pattern, tokens and all. */
  fileName: string;
  /** Whether the name sheet appears before the file is made. */
  prompt: boolean;
  /** Frontmatter for the new file, in the order the template wrote it. */
  matter: [string, string][];
  /** The body, tokens not yet substituted. */
  body: string;
};

/**
 * The two the app ships.
 *
 * `plan.md` first, deliberately: it reproduces what ⌘N did before any of this
 * existed, and ⌘N is bound to whichever template comes first.
 */
export const BUNDLED: [string, string][] = [
  ["plan.md", planText],
  ["daily-note.md", dailyText],
];

/** A title turned into a filename. Kept here because `{slug}` is a token. */
export function slugOf(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
}

/**
 * The template's own frontmatter, read the way the rest of the app reads
 * frontmatter — line by line, no YAML library. One level of nesting is
 * supported and only for `frontmatter:`, which is the only key that needs it;
 * a map is a list of pairs rather than an object so the new file's keys come
 * out in the order they were written.
 */
function parseMatter(matter: string): {
  scalars: Record<string, string>;
  map: [string, string][];
} {
  const scalars: Record<string, string> = {};
  const map: [string, string][] = [];
  let inMap = false;
  for (const line of matter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (inMap && indented) {
      const m = line.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) map.push([m[1], unquote(m[2])]);
      continue;
    }
    if (indented) continue;
    inMap = false;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "frontmatter" && !m[2].trim()) {
      inMap = true;
      continue;
    }
    scalars[m[1]] = unquote(m[2]);
  }
  return { scalars, map };
}

function unquote(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "");
}

/**
 * One template file, or null when it does not describe one.
 *
 * A file without a `name` is skipped rather than guessed at: the name is what
 * the reader picks from a menu, and a template nobody can name is a template
 * nobody can choose.
 */
export function parseTemplate(file: string, text: string): Template | null {
  const split = splitFrontmatter(text);
  if (split.matter === null) return null;
  const { scalars, map } = parseMatter(split.matter);
  const name = scalars.name?.trim();
  if (!name) return null;
  const fileName = scalars.fileName?.trim() || "{slug}.md";
  /*
   * A pattern that mentions the title needs one; a pattern that does not is
   * answered entirely by the calendar, which is what makes the daily note a
   * single keystroke. Spelling `prompt:` out overrides the inference.
   */
  const asked = scalars.prompt?.trim().toLowerCase();
  const prompt =
    asked === "title" ? true : asked === "none" ? false : /\{(slug|title)\}/.test(fileName);
  return { file, name, fileName, prompt, matter: map, body: split.body };
}

/** `yyyy-MM-dd` and friends. A small fixed set; nothing else is substituted. */
function formatDate(fmt: string, now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return fmt.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (t) => {
    switch (t) {
      case "yyyy":
        return String(now.getFullYear());
      case "yy":
        return pad(now.getFullYear() % 100);
      case "MM":
        return pad(now.getMonth() + 1);
      case "dd":
        return pad(now.getDate());
      case "HH":
        return pad(now.getHours());
      case "mm":
        return pad(now.getMinutes());
      default:
        return pad(now.getSeconds());
    }
  });
}

export type Vars = {
  /** What was typed into the name sheet; empty for a template that asks nothing. */
  title: string;
  /** The first word of the configured status vocabulary. */
  firstStatus: string;
  /** Injectable so a test does not have to wait for midnight. */
  now?: Date;
};

/** The fixed set of tokens, substituted wherever they appear. */
function render(text: string, v: Vars): string {
  const now = v.now ?? new Date();
  return text.replace(/\{(slug|title|firstStatus|date:[^}]*)\}/g, (_, token: string) => {
    if (token === "slug") return slugOf(v.title);
    if (token === "title") return v.title;
    if (token === "firstStatus") return v.firstStatus;
    return formatDate(token.slice("date:".length), now);
  });
}

/** The filename this template would give, without the folder it lands in. */
export function renderName(t: Template, v: Vars): string {
  // A pattern is a filename, never a path: a template cannot decide to write
  // outside the folder the reader chose.
  const name = render(t.fileName, v).replace(/[/\\]/g, "-").trim();
  return name || "untitled.md";
}

/**
 * The bytes of the new file.
 *
 * The body is trimmed and given one blank line after it, which is what the
 * hardcoded scaffold used to produce and what "a new file is ready to type in"
 * depends on — the cursor lands on that line. An empty body stays empty, so a
 * daily note is a genuinely blank file.
 */
export function renderContent(t: Template, v: Vars): string {
  // A key whose value renders to nothing is left out rather than written
  // empty — which is how the plan template behaves when the status vocabulary
  // has been emptied, and is what `create_plan` did with no status word.
  const matter = t.matter
    .map(([k, val]) => [k, render(val, v)] as const)
    .filter(([, val]) => val.trim() !== "")
    .map(([k, val]) => `${k}: ${val}`);
  const head = matter.length ? `---\n${matter.join("\n")}\n---\n` : "";
  const body = render(t.body, v).replace(/\s+$/, "");
  return head + (body ? `${body}\n\n` : "");
}

/** The bundled defaults, parsed. The floor under everything below. */
export function bundledTemplates(): Template[] {
  return BUNDLED.map(([file, text]) => parseTemplate(file, text)).filter(
    (t): t is Template => !!t,
  );
}

/**
 * Where the templates came from, ordered.
 *
 * The two shipped names keep their shipped order at the front so that ⌘N goes
 * on meaning "new plan" however the folder happens to sort; everything the
 * reader has added follows, alphabetically by filename.
 */
function order(a: Template, b: Template): number {
  const rank = (t: Template) => {
    const i = BUNDLED.findIndex(([f]) => f === t.file);
    return i === -1 ? BUNDLED.length : i;
  };
  return rank(a) - rank(b) || a.file.localeCompare(b.file);
}

export type Discovered = {
  /** The folder, for the settings row to name. Empty when there is none. */
  dir: string;
  templates: Template[];
  /** Files in the folder that did not describe a template, by name. */
  skipped: string[];
};

/**
 * Read `~/.plans/templates/`, seeding it the first time.
 *
 * Never rejects. In a browser there is no home directory to read and the whole
 * feature would otherwise take ⌘N down with it, so a failure falls back to the
 * bundled pair — which is also the honest answer for a folder someone has
 * emptied.
 */
export async function loadTemplates(): Promise<Discovered> {
  try {
    const found = await api.templatesSync(BUNDLED);
    const templates: Template[] = [];
    const skipped: string[] = [];
    for (const f of found.files) {
      const t = parseTemplate(f.name, f.text);
      if (t) templates.push(t);
      else skipped.push(f.name);
    }
    if (!templates.length) return { dir: found.dir, templates: bundledTemplates(), skipped };
    return { dir: found.dir, templates: templates.sort(order), skipped };
  } catch {
    return { dir: "", templates: bundledTemplates(), skipped: [] };
  }
}
