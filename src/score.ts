/**
 * The app's one fuzzy matcher.
 *
 * It lived in the palette until the dropdowns wanted it too, and two matchers
 * that rank differently would make the same query find different things in
 * different corners of one app — so it lives here, and both import it.
 */

/**
 * Subsequence match, scored so that earlier and tighter runs win. Returns null
 * when the query doesn't appear at all.
 */
export function score(text: string, query: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    streak = found === ti ? streak + 1 : 0;
    total += found === ti ? 3 + streak : -Math.min(found - ti, 12) / 4;
    ti = found + 1;
  }
  // A hit at the very start of the string is worth more than one buried in it.
  return total + (t.startsWith(q) ? 12 : 0);
}
