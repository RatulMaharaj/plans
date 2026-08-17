import { FONTS, MONO_FONTS } from "./fonts";
import { applyTheme, DEFAULT_THEME, type ThemeId } from "./theme";

/** Everything the reader can change, in one place. */
export type Settings = {
  // Paper
  theme: ThemeId;

  // Type
  fontId: string;
  /** The monospaced face used by the chrome and code blocks. */
  monoId: string;
  /** Body size in px, before the per-face optical correction. */
  size: number;
  /** Line length, in characters. */
  measure: number;
  /** Line height as a multiple of the font size. */
  leading: number;
  /** Code block text size in px — code has its own conventions. */
  codeSize: number;

  // Writing
  spellcheck: boolean;
  /**
   * When edits reach disk, in the manner of an IDE:
   * after a pause, when the window loses focus, or only on ⌘S.
   */
  autosave: "afterDelay" | "onBlur" | "manual";
  /** The pause, in seconds, for "afterDelay". */
  autosaveDelay: number;

  // Changes
  diffStyle: "unified" | "split";
  diffLineNumbers: boolean;
  diffWrap: boolean;
  /** Show the whole file, or only the changed hunks with a little context. */
  diffExpandUnchanged: boolean;
  /** Re-diff as you type, versus only against what's saved on disk. */
  diffLive: boolean;

  // Files
  /** Show markdown that .gitignore excludes. */
  showIgnored: boolean;
  /** Filenames as they are on disk, extension and all. */
  showExtensions: boolean;
  /** Hold YAML frontmatter apart from the prose, above the page. */
  showFrontmatter: boolean;
  /** Where a pasted image is written, relative to the repository root. */
  imageFolder: string;

  // Source
  /** Line numbers down the side of the raw markdown. */
  sourceLineNumbers: boolean;
  /** Wrap long lines, or run them on and scroll sideways. */
  sourceWrap: boolean;
  /** Tree text size in px — ⌘+ / ⌘− while the tree has focus. */
  treeSize: number;
  /** Sidebar width in px, dragged by its edge. */
  treeWidth: number;

  // Panels
  /** The file tree down the left. */
  showIndex: boolean;
  showGit: boolean;
  showStatusBar: boolean;
  /** Poll interval for picking up outside edits, in seconds. 0 turns it off. */
  watchSeconds: number;
};

export const DEFAULTS: Settings = {
  theme: DEFAULT_THEME,
  fontId: "vollkorn",
  monoId: "space-mono",
  size: 16,
  measure: 70,
  leading: 1.5,
  codeSize: 12,
  spellcheck: true,
  autosave: "afterDelay",
  autosaveDelay: 2,
  diffStyle: "unified",
  diffLineNumbers: true,
  diffWrap: true,
  diffExpandUnchanged: false,
  diffLive: true,
  showIgnored: false,
  showExtensions: true,
  showFrontmatter: true,
  imageFolder: "assets",
  sourceLineNumbers: true,
  sourceWrap: true,
  treeSize: 12.5,
  treeWidth: 232,
  showIndex: true,
  showGit: false,
  showStatusBar: true,
  watchSeconds: 4,
};

export const RANGES = {
  size: { min: 15, max: 23, step: 1 },
  measure: { min: 52, max: 88, step: 2 },
  leading: { min: 1.35, max: 2, step: 0.01 },
  codeSize: { min: 9, max: 18, step: 0.5 },
  watchSeconds: { min: 0, max: 30, step: 1 },
  autosaveDelay: { min: 0.5, max: 10, step: 0.5 },
  treeSize: { min: 9, max: 16, step: 0.5 },
  treeWidth: { min: 170, max: 480, step: 2 },
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
  root.setProperty("--tree-size", `${s.treeSize}px`);
  root.setProperty("--code-size", `${s.codeSize}px`);
  root.setProperty("--files-w", `${s.treeWidth}px`);
  const mono = MONO_FONTS.find((m) => m.id === s.monoId) ?? MONO_FONTS[0];
  root.setProperty("--mono", mono.stack);
}
