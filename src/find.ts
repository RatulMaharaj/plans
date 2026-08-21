/**
 * In-file find: the contract between the one bar and the per-surface engines.
 *
 * The bar is App's — one instance, floating over the focused pane — and each
 * surface (CodeMirror in Source, ProseMirror in Write) registers an engine
 * here the way SplitPane already registers its flush. The bar never knows
 * which engine it is driving; if seeding from outside were awkward, the bar
 * would own state it should not.
 */

export type FindHandle = {
  /**
   * Recompute matches and highlights for `query`. `seek` makes that match
   * (0-based) the current one — how a palette `*` hit lands on the right
   * occurrence; without it, the current match is the first at or after the
   * cursor, and an unchanged query keeps the match it had.
   */
  set(query: string, seek?: number): void;
  next(): void;
  prev(): void;
  /** Drop the highlights entirely — the bar closed, or moved to another pane. */
  clear(): void;
};

/**
 * Highlight-all stops counting here. A short query in a large plan can match
 * tens of thousands of times, and painting them all is the perf risk the
 * plan named; past the cap the count reads "999+", which is all anyone
 * wanted to know.
 */
export const FIND_CAP = 1000;

/** Smart case: insensitive until the query contains a capital. */
export const findCaseSensitive = (query: string) => /[A-Z]/.test(query);

/**
 * Which occurrence of `query` in `text` sits nearest the start of `line`
 * (1-based). Cross-file search finds a line; the surfaces count occurrences —
 * this is the translation between them, done on the raw text so both engines
 * can be told the same 0-based index.
 */
export function nearestMatchIndex(text: string, query: string, line: number): number {
  if (!query) return 0;
  const cs = findCaseSensitive(query);
  const hay = cs ? text : text.toLowerCase();
  const needle = cs ? query : query.toLowerCase();
  let target = 0;
  for (let n = 1, i = 0; n < line; n++) {
    const nl = text.indexOf("\n", i);
    if (nl < 0) break;
    i = nl + 1;
    target = i;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0, idx = 0; idx < FIND_CAP; idx++) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    const d = Math.abs(at - target);
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
    i = at + Math.max(1, needle.length);
  }
  return best;
}
