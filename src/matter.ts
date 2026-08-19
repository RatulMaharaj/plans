/**
 * YAML frontmatter, held apart from the prose.
 *
 * The editor renders markdown as rich text, which is exactly wrong for a
 * metadata block: "---" becomes a horizontal rule and the keys become loose
 * paragraphs, so round-tripping through the editor would quietly rewrite them.
 * So the block is split off before the editor ever sees it, edited as plain
 * text, and put back verbatim on save.
 */

export type Split = {
  /** The YAML between the fences, without them. Null when there is none. */
  matter: string | null;
  /** Everything after the closing fence. */
  body: string;
  /**
   * The block exactly as it appeared, fences and trailing newline included.
   * Rejoining with this rather than rebuilding keeps the file byte-identical
   * when the metadata wasn't touched — otherwise every open would show a
   * phantom change in the diff.
   */
  raw: string;
};

/**
 * Frontmatter only counts at the very top of the file, opened and closed by a
 * line of exactly three dashes. Anything else is prose that happens to contain
 * dashes, and is left alone.
 */
export function splitFrontmatter(text: string): Split {
  if (!/^---[ \t]*\r?\n/.test(text)) return { matter: null, body: text, raw: "" };
  const close = text.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!close || close.index === undefined) return { matter: null, body: text, raw: "" };
  const open = text.indexOf("\n") + 1;
  const end = close.index + close[0].length;
  return {
    matter: text.slice(open, close.index),
    body: text.slice(end),
    raw: text.slice(0, end),
  };
}

/**
 * Put the two halves back together.
 *
 * `original` is what splitFrontmatter returned when the file was read. If the
 * metadata is unchanged the original block goes back verbatim — same fences,
 * same spacing, same line endings — so reading and rewriting a file is the
 * identity rather than a reformat.
 */
export function joinFrontmatter(
  matter: string | null,
  body: string,
  original?: { matter: string | null; raw: string },
): string {
  if (matter === null) return body;
  if (original && original.matter === matter && original.raw) {
    return original.raw + body;
  }
  const trimmed = matter.replace(/\s+$/, "");
  return `---\n${trimmed}\n---\n${body}`;
}

/**
 * The value of one top-level key, read the way `matterKeys` reads — line by
 * line, no YAML library, no nesting. The app recognises a few conventional
 * keys (`status`, `owner`, `due`) and renders them read-only; anything it
 * doesn't know is simply not rendered. The sheet stays the only writer.
 */
export function matterValue(matter: string, key: string): string | null {
  for (const line of matter.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m || m[1].toLowerCase() !== key.toLowerCase()) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    return v.length ? v : null;
  }
  return null;
}

/**
 * Set, replace or remove one top-level key, touching nothing else. The same
 * line-based reading `matterValue` does: an existing key keeps its place and
 * its spelling, a new one goes at the end, and `null` removes the line.
 */
export function setMatterValue(matter: string, key: string, value: string | null): string {
  const lines = matter.length ? matter.split(/\r?\n/) : [];
  const at = lines.findIndex((l) => {
    const m = l.match(/^([A-Za-z0-9_-]+)\s*:/);
    return !!m && m[1].toLowerCase() === key.toLowerCase();
  });
  if (value === null) {
    if (at !== -1) lines.splice(at, 1);
  } else if (at !== -1) {
    const name = lines[at].match(/^([A-Za-z0-9_-]+)/)![1];
    lines[at] = `${name}: ${value}`;
  } else {
    lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * A handful of statuses get a colour; everything else renders neutral.
 * Recognised case-insensitively, rendered as written — the app reads
 * conventions, it doesn't own a vocabulary.
 */
export function statusTone(
  status: string,
): "draft" | "ready" | "busy" | "done" | "other" {
  const s = status.trim().toLowerCase();
  if (s === "draft" || s === "ready" || s === "busy" || s === "done")
    return s;
  return "other";
}

/**
 * Is this plan finished?
 *
 * Several spellings, because the app reads conventions rather than owning a
 * vocabulary: someone's list says "done", someone else's says "shipped". The
 * set is deliberately small — anything unrecognised is not finished, which is
 * the safe way to be wrong when the answer decides whether a file is shown.
 */
const DONE_WORDS = ["done", "complete", "completed", "shipped", "archived"];

export function isDone(status: string | null | undefined): boolean {
  return !!status && DONE_WORDS.includes(status.trim().toLowerCase());
}

/**
 * The folders whose whole contents are finished by convention.
 *
 * A plan moved into `plans/completed/` often keeps whatever status it had, so
 * the folder is the statement. Matched on any path segment, so it works for
 * `completed/` at the root and `plans/archive/` alike.
 */
const DONE_DIRS = ["completed", "complete", "done", "archive", "archived"];

export function inDoneFolder(relPath: string): boolean {
  const parts = relPath.split("/").slice(0, -1);
  return parts.some((p) => DONE_DIRS.includes(p.trim().toLowerCase()));
}

/** The keys, for the collapsed summary line. */
export function matterKeys(matter: string): string[] {
  return matter
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z0-9_-]+)\s*:/)?.[1])
    .filter((k): k is string => !!k);
}
