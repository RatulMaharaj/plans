---
status: done
---
# Chords, And The Rest Of The Hotkey Plan

`improved-hotkeys.md` shipped the registry (`src/keys.ts`), the sheet (⌘/,
`ShortcutSheet.tsx`), and overrides (`keyOverrides` in settings), and
deliberately deferred the rest. This plan is the rest — chords, a real
Keyboard page in Settings, and preset keybinding packs.

## The trigger, restated

The original argument was: chords are only worth building once the
single-keystroke space is genuinely full. The sheet now shows how full it
is. The split-pane work spent ⌘, ⌘⌥, ⌘⌥1/2 and turned ⌘W polysemous
(split tab, then pane, then buffer); the view switch grew ⌥-click as a
modifier because a fourth meaning had nowhere to live on the keys. The find
work just spent ⌘F too. The human has now asked for the rest directly, so
the trigger has fired.

## Chords, on the registry

A chord is a `KeySpec` with a space in it: `"mod+k mod+w"`. Everything else
follows from keeping that one representation:

- **Matching** (`matchKeys`, `src/keys.ts`): a spec with a space matches in
  two steps. The keydown lookup in `App.tsx` grows a `pendingChord` ref —
  when an event matches the *first* half of any bound chord, swallow it, arm
  the pending state, and start a ~1.5s timeout. The next keydown either
  completes a chord, or clears the state and is processed normally. All of
  it stays inside the existing single lookup; no second dispatch path.
- **The indicator**: a half-typed chord must be visible or it reads as the
  app dropping keystrokes. The status bar is already the app's quiet voice —
  render the armed prefix there (`⌘K …`), cleared on completion or timeout.
- **Capture** (`specFrom` / the rebind UI): the rebind capture learns to
  accept two combos — after the first, keep capturing for a beat instead of
  committing, exactly the timeout the matcher uses. ⌫ and Esc keep their
  meanings.
- **Rendering** (`renderKeys`): a space becomes a thin joiner — `⌘K ⌘W` —
  and the palette hints inherit it for free, since hints are already
  rendered from the registry.

**The prefix decision, made now:** ⌘K becomes the chord prefix. The palette
keeps ⌘P/⌘⇧P, which already open the same box; ⌘K's palette meaning goes.
This is what the muscle memory of every VS Code hand expects.

**Conflict rules extend, not change:** the rebind UI already refuses a
binding another command holds. Two more refusals: a chord whose prefix is
another command's whole binding (the prefix would swallow it), and a single
binding equal to an existing chord's prefix (same problem, other
direction).

**First real chords**, from the pressure that exists today: the ⌘W family
(`mod+k w` close all buffers alongside ⌘W's close-this) and the view
overrides that ride on ⌥-click.

## A Keyboard page in Settings

Rebinding today lives only in the shortcut sheet. The human asked for
customisable hotkeys "in a page similar to settings" — so the sheet stays
the quick reference (⌘/), and a **Settings → Keyboard** page becomes the
place bindings are managed:

- Every registry command, grouped as the sheet groups them, each with its
  current keys rendered, a capture-to-rebind control, unbind, and
  reset-to-default; overridden rows visibly marked.
- The contextual (hand-written) and editor-local keys listed read-only, so
  the page is complete about what it does not own.
- The same conflict refusals as the sheet, same wording.
- A "Reset all" that clears `keyOverrides`.

## Preset keybinding packs

`keyOverrides` is `{ [commandId]: keys }` merged over defaults. A pack is
the same shape with a different source: a named, hand-kept table shipped in
`src/keys.ts` (or a sibling module), chosen on the Keyboard page.

- Setting: `keyPreset: "default" | "vscode" | "vim"`, default `"default"`.
  Merge order: defaults ← pack ← the reader's own overrides, so personal
  rebinds survive switching packs.
- **VS Code pack**: where this app's command has a VS Code sibling, use its
  keys — ⌘K W for close-all, ⌘K ⌘S opens the Keyboard page, ⌘⇧F for
  cross-file search (the palette's `*`), ⌃` for the agent chat, etc. Kept
  small and honest: only commands that exist here.
- **Vim pack**: app-level navigation in vim's spirit where the app's chrome
  allows — this is *not* modal editing. Modal editing lives inside the
  editor surfaces and remains its own future plan; the page says so in a
  sentence next to the pack, so nobody buys more than is sold.

## Editor-local keys join the sheet, read-only

List bold/italic and friends in the sheet's (and Keyboard page's) fixed
section from a small hand-kept table; not rebindable. They belong to
Milkdown and CodeMirror.

## Next

- [x] `matchKeys`/`specFrom`/`renderKeys` learn the two-step spec
- [x] `pendingChord` in the keydown lookup, timeout, status-bar indicator
- [x] ⌘K moves from palette-door to chord prefix; palette keeps ⌘P/⌘⇧P
- [x] Capture takes chords; the two new conflict refusals
- [x] Settings → Keyboard page: rebind, unbind, reset, reset-all,
      read-only contextual + editor-local sections
- [x] `keyPreset` setting and the pack merge order; VS Code and Vim packs
- [x] First real chords (⌘W family, view overrides)
- [x] Tests: chord matching/timeout, conflict refusals, pack merge order,
      and an e2e pass over the Keyboard page (`e2e/keys.spec.ts`)
