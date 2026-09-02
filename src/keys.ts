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

/**
 * "mod+shift+o" — lowercase parts joined by "+", the last part the key.
 * A space makes it a chord: "mod+k w" is ⌘K, then W, within `CHORD_MS`.
 */
export type KeySpec = string;

/**
 * How long a chord prefix stays armed — both in the matcher and in the rebind
 * capture, which waits exactly this long for a second combo.
 */
export const CHORD_MS = 1500;

/** The combos of a spec: one for a plain binding, two for a chord. */
export function chordParts(keys: KeySpec): string[] {
  return keys.split(" ").filter(Boolean);
}

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
  // The first chords, from the pressure that already existed: ⌘W's family
  // grew a third meaning, and the pane-only view switch had nowhere to live
  // but ⌥-click. ⌘K is the prefix — the palette keeps ⌘P/⌘⇧P.
  { id: "tab.closeAll", group: "Go", label: "Close all buffers", keys: "mod+k w" },
  { id: "v.write.pane", group: "Go", label: "Write view — this pane only", keys: "mod+k mod+1" },
  { id: "v.source.pane", group: "Go", label: "Source view — this pane only", keys: "mod+k mod+2" },
  { id: "v.keyboard", group: "Go", label: "Keyboard settings", keys: "mod+k mod+s" },
  // Below the older chords on purpose: the first ⌘K chord in this table is
  // the one the "taken prefix" note names, and that should stay ⌘K W.
  { id: "showAllFiles", group: "Panels", label: "Show all files", keys: "mod+k a" },
];

/**
 * The keys that stay hand-written, so the sheet can be honest about them.
 * Listed here for display only — nothing matches against these.
 */
export const CONTEXTUAL_KEYS: { keys: string; label: string; note: string }[] = [
  { keys: "mod+p", label: "Palette — files", note: "⇧ for commands" },
  { keys: "mod+ctrl+p", label: "Profiler", note: "" },
  { keys: "mod+=", label: "Bigger text", note: "the tree when it has focus, the page otherwise" },
  { keys: "mod+-", label: "Smaller text", note: "same target as bigger" },
  { keys: "mod+b", label: "File tree", note: "bold while writing; ⌘⌃B always toggles the tree" },
  { keys: "mod+backspace", label: "Delete file", note: "only from the tree" },
  { keys: "escape", label: "Back out", note: "leaves the editor, then zen or settings" },
];

/**
 * The keys that belong to the editor surfaces — Milkdown while writing,
 * CodeMirror in Source — listed so the sheet and the Keyboard page can be
 * complete about what they do not own. Display only, hand-kept, small.
 */
export const EDITOR_KEYS: { keys: string; label: string; note: string }[] = [
  { keys: "mod+b", label: "Bold", note: "while writing — the tree gets it otherwise" },
  { keys: "mod+i", label: "Italic", note: "" },
  { keys: "mod+z", label: "Undo", note: "" },
  { keys: "mod+shift+z", label: "Redo", note: "" },
  { keys: "mod+/", label: "Toggle comment", note: "in the source view" },
];

export type KeyPreset = "default" | "vscode" | "vim";

/**
 * Preset packs: the same shape as `keyOverrides`, from a different source.
 * Strictly opt-in — the app's own bindings stay the defaults — and kept
 * small and honest: only commands that exist here.
 */
export const PRESETS: Record<
  Exclude<KeyPreset, "default">,
  { label: string; note: string; keys: Record<string, KeySpec> }
> = {
  vscode: {
    label: "VS Code",
    note: "Only the commands this app shares with VS Code take its keys.",
    keys: {
      "tab.closeAll": "mod+k w",
      showMux: "ctrl+`",
      showGit: "ctrl+shift+g",
      zen: "mod+k z",
      "v.keyboard": "mod+k mod+s",
    },
  },
  vim: {
    // The ⌃W window family, which is where vim's spirit and this app's
    // chrome actually overlap.
    label: "Vim",
    note: "App navigation only — modal editing is a separate future feature.",
    keys: {
      split: "ctrl+w v",
      "split.dir": "ctrl+w s",
      "pane.1": "ctrl+w h",
      "pane.2": "ctrl+w l",
      "tab.close": "ctrl+w q",
      "tab.closeAll": "ctrl+w o",
    },
  },
};

/**
 * The merged keymap: the defaults, then the chosen pack, then the reader's
 * own overrides — exactly as `loadSettings` merges a stored blob over
 * `DEFAULTS`, and so that personal rebinds survive switching packs. An
 * override of "" unbinds the command.
 */
export function mergeKeys(overrides: Record<string, KeySpec>, preset: KeyPreset = "default"): KeymapEntry[] {
  const pack = preset === "default" ? {} : PRESETS[preset].keys;
  return DEFAULT_KEYS.map((e) => {
    const keys = overrides[e.id] ?? pack[e.id] ?? e.keys;
    return keys === e.keys ? e : { ...e, keys };
  });
}

/** One combo — the half of `matchKeys` that reads an event. */
function matchCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
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

/**
 * Does this event mean this spec? Modifiers match exactly, not at-least.
 * A spec with a space matches in two steps: with no `pending` prefix armed,
 * only plain bindings answer; with one, only the second combo of chords
 * whose first combo is that prefix.
 */
export function matchKeys(e: KeyboardEvent, keys: KeySpec, pending: KeySpec | null = null): boolean {
  if (!keys) return false;
  const steps = chordParts(keys);
  if (pending !== null) return steps.length === 2 && steps[0] === pending && matchCombo(e, steps[1]);
  return steps.length === 1 && matchCombo(e, steps[0]);
}

/** The first combo of a two-step spec, when this event presses it. */
export function matchChordPrefix(e: KeyboardEvent, keys: KeySpec): KeySpec | null {
  if (!keys) return null;
  const steps = chordParts(keys);
  return steps.length === 2 && matchCombo(e, steps[0]) ? steps[0] : null;
}

/**
 * Why this spec cannot be given to this command, or null. One wording, used
 * by the sheet and the Keyboard page alike: an exact duplicate, a chord whose
 * prefix is another command's whole binding (the prefix would swallow it),
 * and a plain binding sitting on an existing chord's prefix (same problem,
 * the other way round).
 */
export function bindingConflict(spec: KeySpec, id: string, merged: KeymapEntry[]): string | null {
  const mine = chordParts(spec);
  for (const k of merged) {
    if (k.id === id || !k.keys) continue;
    const theirs = chordParts(k.keys);
    if (k.keys === spec)
      return `${renderKeys(spec)} already runs “${k.label}” — unbind that first.`;
    if (mine.length === 2 && theirs.length === 1 && theirs[0] === mine[0])
      return `${renderKeys(mine[0])} already runs “${k.label}” — a chord starting there would swallow it. Unbind that first.`;
    if (mine.length === 1 && theirs.length === 2 && theirs[0] === mine[0])
      return `${renderKeys(spec)} starts the ${renderKeys(k.keys)} chord for “${k.label}” — unbind that first.`;
  }
  return null;
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

/**
 * "mod+shift+o" → "⌘⇧O", the way the palette has always written them. A
 * chord's space becomes a joiner between its combos: "mod+k w" → "⌘K W".
 */
export function renderKeys(keys: KeySpec): string {
  if (!keys) return "";
  return chordParts(keys)
    .map((combo) =>
      combo
        .toLowerCase()
        .split("+")
        .map((p) => GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p.toUpperCase()))
        .join(""),
    )
    .join(" ");
}
