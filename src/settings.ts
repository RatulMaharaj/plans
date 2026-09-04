import { FONTS, MONO_FONTS } from "./fonts";
import { applyTheme, DEFAULT_THEME, type ThemeId } from "./theme";
import { HANDOFF_PROMPT, IMPLEMENT_PROMPT, REWRITE_PROMPT } from "./agent";

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
   * Whether finished plans stay in the tree. Off hides anything whose status
   * reads as done, and anything inside a `completed/`-style folder — the two
   * ways this app's own repository says a plan is over.
   */
  showCompleted: boolean;
  /**
   * Every text file in the tree, not only the markdown. Off is the default:
   * a plans repository wants plans, not the machinery around them.
   */
  showAllFiles: boolean;
  /**
   * The choices the palette offers for `status:`, comma-separated. A
   * convention, not a schema — a file may say anything; these are only what
   * the app offers to write.
   */
  statuses: string;
  /** Where a pasted image is written, relative to the repository root. */
  imageFolder: string;
  /**
   * The repositories in the sidebar, as absolute paths, in order.
   *
   * In the file rather than only in the window's own storage so that every
   * build of the app on this machine — the installed one, one run from
   * source — shows the same list. Adding, forgetting and reordering write
   * it; editing it here is the same as doing those in the app.
   */
  repos: string[];

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
   * The copyable agent command, as a template.
   *
   * `{prompt}` is the instruction, `{file}` the plan's repo-relative path.
   * A template rather than a binary name because no two agents take a prompt
   * the same way, and this app has no business preferring one.
   */
  agentCommand: string;
  /**
   * Which agent from the catalogue the chat talks to.
   *
   * An id, not a command line. Every entry speaks ACP, so the argv is the
   * app's business and what the agent can do is the agent's — there is
   * nothing left here to configure but the choice.
   */
  chatCommand: string;
  /**
   * The instruction "Hand off to agent: complete this plan" sends. Editable
   * because it is the one piece of the feature that is about *your* house
   * style, and a prompt you cannot see is a prompt you cannot argue with.
   */
  handoffPrompt: string;
  /**
   * The instruction "Hand off to agent: implement this plan" sends. Kept
   * apart from the completion prompt because they ask for different moves:
   * one writes the plan, the other builds from it.
   */
  implementPrompt: string;
  /**
   * The instruction "Rewrite…" sends for a selected passage. `{file}` is the
   * file, `{quote}` the selected text, `{ask}` what you typed, and `{lines}`
   * a line-range hint that is empty unless the quote is unique in the file.
   */
  rewritePrompt: string;
  /**
   * Whether `#` in the palette reaches the conversations of the repository you
   * are in, or of every repository open.
   *
   * Per-repo by default, because a chat is usually about the plans next to it
   * and a list that changes as you move between repositories is that list being
   * right. "All" is for the other habit — one train of thought that outlives
   * which window happens to be focused. A setting rather than a guess, because
   * both are correct and which one you want is a fact about you.
   */
  chatScope: "repo" | "all";
  /**
   * What orders the files in the tree.
   *
   * By name is the order a tree is read in, and the one to fall back to. By
   * status is the cheap answer to wanting a plans folder sequenced some other
   * way: the status is already read on every file during the walk, so it costs
   * a comparison rather than a new field to maintain by hand — and unlike a
   * number typed into every file, it cannot drift out of step with itself.
   * Files with an unrecognised status, or none, come last either way.
   */
  treeSort: "name" | "status";

  // Panels
  /** The file tree down the left. */
  showIndex: boolean;
  showGit: boolean;
  /** The agent chat. Nothing runs while it is closed. */
  showMux: boolean;
  showStatusBar: boolean;
  /**
   * Where the chat sits: a column on the right, or a row under the document.
   *
   * Beside by default. A conversation is read down, so height is what it
   * wants, and the plan stays fully visible next to it rather than being
   * squeezed into the top half of the window.
   */
  chatPlace: "bottom" | "side";
  /** Height of the chat in px, when it is the bottom row. */
  muxHeight: number;
  /** Width of the chat in px, when it is the right column. */
  chatWidth: number;
  /**
   * Poll interval for picking up outside edits to files in your repositories,
   * in seconds. 0 turns it off. The settings file has its own fixed interval,
   * so turning this off never leaves the app deaf to its own settings.
   */
  watchSeconds: number;

  /**
   * Rebound shortcuts, by command id, merged over the registry's defaults the
   * way this whole blob merges over `DEFAULTS`. "" means unbound. The shortcut
   * sheet (⌘/) is the easy way in; the settings file is the other, and with a
   * schema completing command ids it is a respectable one.
   */
  keyOverrides: Record<string, string>;
  /**
   * The preset keybinding pack merged between the registry's defaults and
   * `keyOverrides` — personal rebinds survive switching packs. Strictly
   * opt-in: "default" is the app's own bindings, untouched.
   */
  keyPreset: "default" | "vscode" | "vim";

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
  repos: [],
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
  showCompleted: true,
  showAllFiles: false,
  statuses: "draft, ready, approved, busy, done",
  agentCommand: "claude {prompt}",
  chatCommand: "claude",
  handoffPrompt: HANDOFF_PROMPT,
  implementPrompt: IMPLEMENT_PROMPT,
  rewritePrompt: REWRITE_PROMPT,
  chatScope: "repo" as const,
  treeSort: "name" as const,
  imageFolder: "assets",
  sourceLineNumbers: true,
  sourceWrap: true,
  treeSize: 12.5,
  treeWidth: 232,
  showIndex: true,
  showGit: false,
  showMux: false,
  chatPlace: "side",
  muxHeight: 260,
  chatWidth: 420,
  showStatusBar: true,
  watchSeconds: 4,
  keyOverrides: {},
  keyPreset: "default",
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
  chatWidth: { min: 340, max: 720, step: 10 },
};

const KEY = "plans.settings.v1";

/**
 * A blob of anything into the settings this build understands.
 *
 * Shared by both readers — the localStorage warm start and the file on disk —
 * because the two carry the same shape and want the same forgiveness. In
 * particular the statuses fix-up below outlived the move to a file: a blob
 * from an older build can arrive through either door, and now also from
 * another machine, so the day the file landed was not the day it could retire.
 */
export function mergeSettings(raw: Partial<Settings> | null | undefined): Settings {
  // Merge over defaults so a settings file from an older build still opens.
  const s = raw ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
  // A saved list that still matches an earlier default hasn't been
  // customised; move it to the current default. Edited lists are untouched.
  const normalized = String(s.statuses ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
  if (
    normalized === "draft,active,done,blocked" ||
    normalized === "draft,triage,active,done,blocked" ||
    normalized === "draft,triage,active,busy,done,blocked" ||
    normalized === "draft,ready,busy,done"
  )
    s.statuses = DEFAULTS.statuses;
  // The same rule for the handoff prompt: a saved copy of the old default -
  // whose style rules had drifted into contradicting the plans skill - moves
  // to the current one, and an edited prompt is untouched.
  if (
    s.handoffPrompt ===
    "Take over the plan at {file} and take it further. Keep the house style of " +
      "this folder: argue the design rather than listing steps, cite file:line " +
      "for anything you claim about the code, keep an open questions section, " +
      "and end with a Next checklist. Do not change any file other than the plan."
  )
    s.handoffPrompt = DEFAULTS.handoffPrompt;
  return s;
}

/**
 * The warm start.
 *
 * The file is canonical, but a Tauri command is async and the theme is wanted
 * before the first paint — so launch reads this synchronously, exactly as it
 * always did, and the file reconciles a moment later. Nothing but the app ever
 * writes it, so the reconciliation has no third author to fear.
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return mergeSettings(raw ? (JSON.parse(raw) as Partial<Settings>) : null);
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/* --- the file ------------------------------------------------------------ */

/**
 * Keys in the file that this build has no `Settings` field for.
 *
 * Kept rather than dropped, and written back on every save. VS Code does the
 * same, and the reason is the same: a file edited by a newer build, or by a
 * hand that got ahead of the release, should survive being opened by this one.
 * The cost is that a save writes the parsed file rather than the app's own
 * object — which is this type, threaded through `parseSettingsFile` and
 * `serializeSettings`.
 */
export type Extras = Record<string, unknown>;

/** The schema written beside the file, so completion works offline. */
export const SCHEMA_REF = "./settings.schema.json";

const KNOWN = new Set<string>(Object.keys(DEFAULTS));

/**
 * Read the file. Throws on anything that is not a JSON object — the caller
 * keeps the last good settings and says so, because "you have a typo" is
 * recoverable and "your settings reset" is rage.
 *
 * Plain JSON, not JSONC: a lenient parser and a comment-preserving writer are
 * real machinery, and the schema's hover-help carries the prose that comments
 * would have. If annotating the file turns out to matter, it is its own plan.
 */
export function parseSettingsFile(text: string): { settings: Settings; extras: Extras } {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.json is not a JSON object");
  }
  const known: Partial<Settings> = {};
  const extras: Extras = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // `$schema` is the app's to write, not a setting and not an extra.
    if (k === "$schema") continue;
    if (KNOWN.has(k)) (known as Record<string, unknown>)[k] = v;
    else extras[k] = v;
  }
  return { settings: mergeSettings(known), extras };
}

/**
 * The file as this app writes it: the schema reference first, then the settings
 * in the order the type declares them, then anything it did not recognise.
 */
export function serializeSettings(s: Settings, extras: Extras = {}): string {
  const out: Record<string, unknown> = { $schema: SCHEMA_REF };
  for (const k of Object.keys(DEFAULTS)) out[k] = (s as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(extras)) if (!(k in out)) out[k] = v;
  return `${JSON.stringify(out, null, 2)}\n`;
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
