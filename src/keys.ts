/**
 * The keymap: one place a shortcut is defined.
 *
 * Commands already exist as data in the palette; the bindings used to exist a
 * second time as an `else if` chain in App.tsx, and the two agreed only
 * because someone kept them agreeing. This table is the single source: the
 * keydown handler matches against it, the palette renders its hints from it,
 * and the shortcut sheet is a view of it.
 *
 * Only *unconditional* bindings live here. Keys whose meaning depends on what
 * is on screen — Escape, ⌘B while writing, ⌘+/− by focus — stay hand-written
 * in App.tsx, deliberately: a table entry cannot express "but only in zen",
 * and a `when` clause is the first step toward a keybinding system this app
 * does not need.
 */

/** "mod+shift+o" — lowercase parts joined by "+", the last part the key. */
export type KeySpec = string;

export type KeymapEntry = {
  /** Matches the palette command's id where one exists, so hints derive. */
  id: string;
  group: string;
  label: string;
  keys: KeySpec;
};

export const DEFAULT_KEYS: KeymapEntry[] = [
  { id: "save", group: "Plans", label: "Save now", keys: "mod+s" },
  { id: "new", group: "Plans", label: "New plan", keys: "mod+n" },
  { id: "comment", group: "Plans", label: "New comment", keys: "mod+shift+m" },
  // "Find in this document" does not depend on what is on screen, which is
  // this table's admission test. Diff quietly declines it, and that decision
  // lives with the other view-dependent choices in App.
  { id: "find", group: "Plans", label: "Find in this file", keys: "mod+f" },
  { id: "rename", group: "Plans", label: "Rename this file", keys: "f2" },
  { id: "repo.add", group: "Repositories", label: "Add a repository", keys: "mod+shift+o" },
  { id: "v.write", group: "Go", label: "Write view", keys: "mod+1" },
  { id: "v.source", group: "Go", label: "Source view", keys: "mod+2" },
  { id: "v.settings", group: "Go", label: "Settings", keys: "mod+," },
  { id: "zen", group: "Go", label: "Zen", keys: "mod+shift+l" },
  { id: "tab.close", group: "Go", label: "Close this buffer", keys: "mod+w" },
  { id: "tab.next", group: "Go", label: "Next buffer", keys: "ctrl+tab" },
  { id: "tab.prev", group: "Go", label: "Previous buffer", keys: "ctrl+shift+tab" },
  { id: "tab.next2", group: "Go", label: "Next buffer (again)", keys: "mod+alt+arrowright" },
  { id: "tab.prev2", group: "Go", label: "Previous buffer (again)", keys: "mod+alt+arrowleft" },
  { id: "showMux", group: "Panels", label: "Agent chat", keys: "mod+j" },
  { id: "showGit", group: "Panels", label: "Git panel", keys: "mod+g" },
  { id: "shortcuts", group: "Go", label: "Keyboard shortcuts", keys: "mod+/" },
  // The near-universal split bindings. ⌘⌥1/2 rather than ⌘1/2 for pane focus:
  // the bare digits are the view switch, and that muscle memory is older.
  { id: "split", group: "Go", label: "Split — another file beside this one", keys: "mod+\\" },
  { id: "split.dir", group: "Go", label: "Split the other way", keys: "mod+alt+\\" },
  { id: "pane.1", group: "Go", label: "Focus the first pane", keys: "mod+alt+1" },
  { id: "pane.2", group: "Go", label: "Focus the second pane", keys: "mod+alt+2" },
];

/**
 * The keys that stay hand-written, so the sheet can be honest about them.
 * Listed here for display only — nothing matches against these.
 */
export const CONTEXTUAL_KEYS: { keys: string; label: string; note: string }[] = [
  { keys: "mod+p", label: "Palette — files", note: "⇧ for commands; ⌘K either way" },
  { keys: "mod+ctrl+p", label: "Profiler", note: "" },
  { keys: "mod+=", label: "Bigger text", note: "the tree when it has focus, the page otherwise" },
  { keys: "mod+-", label: "Smaller text", note: "same target as bigger" },
  { keys: "mod+b", label: "File tree", note: "bold while writing; ⌘⌃B always toggles the tree" },
  { keys: "mod+backspace", label: "Delete file", note: "only from the tree" },
  { keys: "escape", label: "Back out", note: "leaves the editor, then zen or settings" },
];

/**
 * The merged keymap: the defaults with the reader's overrides on top, exactly
 * as `loadSettings` merges a stored blob over `DEFAULTS`. An override of ""
 * unbinds the command.
 */
export function mergeKeys(overrides: Record<string, KeySpec>): KeymapEntry[] {
  return DEFAULT_KEYS.map((e) => (overrides[e.id] === undefined ? e : { ...e, keys: overrides[e.id] }));
}

/** Does this event mean this spec? Modifiers match exactly, not at-least. */
export function matchKeys(e: KeyboardEvent, keys: KeySpec): boolean {
  if (!keys) return false;
  const parts = keys.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const has = (m: string) => parts.slice(0, -1).includes(m);
  // "ctrl" is the literal key, for bindings like ⌃Tab that must not answer to
  // ⌘Tab. "mod" is the platform command key: ⌘ or, elsewhere, Ctrl.
  if (has("ctrl")) {
    if (!e.ctrlKey || e.metaKey) return false;
  } else if (has("mod")) {
    if (!(e.metaKey || e.ctrlKey)) return false;
    if (e.ctrlKey && e.metaKey) return false;
  } else if (e.metaKey || e.ctrlKey) return false;
  if (e.shiftKey !== has("shift")) return false;
  if (e.altKey !== has("alt")) return false;
  return e.key.toLowerCase() === key;
}

/** A KeySpec from a keydown, for the sheet's "press the new keys" capture. */
export function specFrom(e: KeyboardEvent): KeySpec | null {
  const key = e.key.toLowerCase();
  if (["meta", "control", "shift", "alt"].includes(key)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("mod");
  else if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const GLYPH: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  tab: "⇥",
  backspace: "⌫",
  escape: "esc",
  arrowright: "→",
  arrowleft: "←",
  arrowup: "↑",
  arrowdown: "↓",
};

/** "mod+shift+o" → "⌘⇧O", the way the palette has always written them. */
export function renderKeys(keys: KeySpec): string {
  if (!keys) return "";
  return keys
    .toLowerCase()
    .split("+")
    .map((p) => GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p.toUpperCase()))
    .join("");
}
