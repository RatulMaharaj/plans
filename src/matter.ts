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

/** The keys, for the collapsed summary line. */
export function matterKeys(matter: string): string[] {
  return matter
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z0-9_-]+)\s*:/)?.[1])
    .filter((k): k is string => !!k);
}
