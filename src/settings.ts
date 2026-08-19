import { FONTS, MONO_FONTS } from "./fonts";
import { applyTheme, DEFAULT_THEME, type ThemeId } from "./theme";
import { FLESH_OUT_PROMPT } from "./agent";

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
  /**
   * The choices the palette offers for `status:`, comma-separated. A
   * convention, not a schema — a file may say anything; these are only what
   * the app offers to write.
   */
  statuses: string;
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

  // Agents
  /**
   * The command run by "Flesh out this plan", as a template.
   *
   * `{prompt}` is the instruction, `{file}` the plan's repo-relative path.
   * A template rather than a binary name because no two agents take a prompt
   * the same way, and this app has no business preferring one.
   */
  agentCommand: string;
  /**
   * The binary the chat panel talks to. A name rather than a template: the
   * flags that make it stream are owned by the Rust side, so the one thing to
   * configure is which agent answers.
   */
  chatCommand: string;
  /**
   * The instruction "Flesh out this plan" sends. Editable because it is the
   * one piece of the feature that is about *your* house style, and a prompt
   * you cannot see is a prompt you cannot argue with.
   */
  fleshOutPrompt: string;

  // Panels
  /** The file tree down the left. */
  showIndex: boolean;
  showGit: boolean;
  /** The agent chat. Nothing runs while it is closed. */
  showMux: boolean;
  showStatusBar: boolean;
  /**
   * Where the chat sits: a row under the document, or a column on the right.
   * Two shapes because the panel is read two ways — a transcript you glance
   * at while writing wants to be tall and narrow, one you are working *in*
   * wants the width.
   */
  chatPlace: "bottom" | "side";
  /** Height of the chat in px, when it is the bottom row. */
  muxHeight: number;
  /** Width of the chat in px, when it is the right column. */
  chatWidth: number;
  /** Poll interval for picking up outside edits, in seconds. 0 turns it off. */
  watchSeconds: number;

  // Updates
  /**
   * Whether the app looks for a new version of itself. There is no "auto":
   * replacing a running editor's binary without being asked is not a thing to
   * do to someone who has unsaved text in it.
   */
  updates: "notify" | "off";
  /**
   * Anonymous usage counts, so the app can be improved by something other than
   * guesswork. Never file names, paths, or text. Off means nothing is sent.
   */
  telemetry: boolean;
  /**
   * The version whose release notes have been shown. Anything older than what
   * is running means the notes open once, by themselves, after an update.
   */
  lastSeenVersion: string;
};

export const DEFAULTS: Settings = {
  theme: DEFAULT_THEME,
  fontId: "work-sans",
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
  statuses: "draft, ready, busy, done",
  agentCommand: "claude {prompt}",
  chatCommand: "claude",
  fleshOutPrompt: FLESH_OUT_PROMPT,
  imageFolder: "assets",
  sourceLineNumbers: true,
  sourceWrap: true,
  treeSize: 12.5,
  treeWidth: 232,
  showIndex: true,
  showGit: false,
  showMux: false,
  chatPlace: "bottom",
  muxHeight: 260,
  chatWidth: 380,
  showStatusBar: true,
  watchSeconds: 4,
  updates: "notify",
  telemetry: true,
  // Empty rather than the current version: a settings blob from an older build
  // merged over these defaults reads as "never seen", and shows the notes once.
  lastSeenVersion: "",
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
  muxHeight: { min: 120, max: 600, step: 10 },
  chatWidth: { min: 260, max: 640, step: 10 },
};

const KEY = "plans.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    // Merge over defaults so a settings file from an older build still opens.
    const s = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
    // A saved list that still matches an earlier default hasn't been
    // customised; move it to the current default. Edited lists are untouched.
    const normalized = s.statuses
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .join(",");
    if (
      normalized === "draft,active,done,blocked" ||
      normalized === "draft,triage,active,done,blocked" ||
      normalized === "draft,triage,active,busy,done,blocked"
    )
      s.statuses = DEFAULTS.statuses;
    return s;
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
