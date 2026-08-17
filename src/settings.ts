import { FONTS } from "./fonts";
import { applyTheme, DEFAULT_THEME, type ThemeId } from "./theme";

/** Everything the reader can change, in one place. */
export type Settings = {
  // Paper
  theme: ThemeId;

  // Type
  fontId: string;
  /** Body size in px, before the per-face optical correction. */
  size: number;
  /** Line length, in characters. */
  measure: number;
  /** Line height as a multiple of the font size. */
  leading: number;

  // Writing
  spellcheck: boolean;

  // Changes
  diffStyle: "unified" | "split";
  diffLineNumbers: boolean;
  diffWrap: boolean;
  /** Show the whole file, or only the changed hunks with a little context. */
  diffExpandUnchanged: boolean;
  /** Re-diff as you type, versus only against what's saved on disk. */
  diffLive: boolean;

  // Panels
  showGit: boolean;
  showStatusBar: boolean;
  /** Poll interval for picking up outside edits, in seconds. 0 turns it off. */
  watchSeconds: number;
};

export const DEFAULTS: Settings = {
  theme: DEFAULT_THEME,
  fontId: "vollkorn",
  size: 18,
  measure: 66,
  leading: 1.62,
  spellcheck: true,
  diffStyle: "unified",
  diffLineNumbers: true,
  diffWrap: true,
  diffExpandUnchanged: false,
  diffLive: true,
  showGit: false,
  showStatusBar: true,
  watchSeconds: 4,
};

export const RANGES = {
  size: { min: 15, max: 23, step: 1 },
  measure: { min: 52, max: 88, step: 2 },
  leading: { min: 1.35, max: 2, step: 0.01 },
  watchSeconds: { min: 0, max: 30, step: 1 },
};

const KEY = "plans.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    // Merge over defaults so a settings file from an older build still opens.
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function applySettings(s: Settings) {
  applyTheme(s.theme);
  const font = FONTS.find((f) => f.id === s.fontId) ?? FONTS[0];
  const root = document.documentElement.style;
  root.setProperty("--doc-font", font.stack);
  root.setProperty("--doc-size", `${(s.size * font.scale).toFixed(2)}px`);
  root.setProperty("--doc-measure", `${s.measure}ch`);
  root.setProperty("--doc-leading", String(s.leading));
}
