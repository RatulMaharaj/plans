/**
 * Three papers, in the manner of an e-reader's Aa menu.
 *
 * The rule for all three: the only chromatic colour anywhere in the app is a
 * git state. Everything else is ink at some opacity. If it has colour, it means
 * the file differs from what's committed.
 */
export type ThemeId = "day" | "sepia" | "night";

export type Theme = {
  id: ThemeId;
  label: string;
  /** Shown as the swatch in the Aa menu. */
  swatch: { paper: string; ink: string };
};

export const THEMES: Theme[] = [
  { id: "day", label: "Day", swatch: { paper: "#FBFBF9", ink: "#17181B" } },
  { id: "sepia", label: "Sepia", swatch: { paper: "#E9DFCB", ink: "#33291F" } },
  { id: "night", label: "Night", swatch: { paper: "#121316", ink: "#C8C5BE" } },
];

export const DEFAULT_THEME: ThemeId = "day";

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
}
