---
status: draft
---
# Chords, And The Rest Of The Hotkey Plan

`improved-hotkeys.md` shipped the registry (`src/keys.ts`), the sheet (⌘/,
`ShortcutSheet.tsx`), and overrides (`keyOverrides` in settings), and
deliberately deferred the rest. This plan is the rest, in the order it
becomes worth doing — and an honest note on what still is not.

## The trigger, restated

The original argument was: chords are only worth building once the
single-keystroke space is genuinely full. The sheet now shows how full it
is. The split-pane work spent ⌘, ⌘⌥, ⌘⌥1/2 and turned ⌘W polysemous
(split tab, then pane, then buffer); the view switch grew ⌥-click as a
modifier because a fourth meaning had nowhere to live on the keys. That is
what "the space is filling" looks like from inside. Not full yet — but the
shape of the work can be written down now, so that when the next binding has
no home, the answer is a table entry rather than a design session.

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
- **Capture** (`specFrom` / `ShortcutSheet.tsx`): the sheet's rebind capture
  learns to accept two combos — after the first, keep capturing for a beat
  instead of committing, exactly the timeout the matcher uses. ⌫ and Esc
  keep their meanings.
- **Rendering** (`renderKeys`): a space becomes a thin joiner — `⌘K ⌘W` —
  and the palette hints inherit it for free, since hints are already
  rendered from the registry.

**The collision that must be decided first:** ⌘K is a door into the palette
today (`App.tsx`, hand-written, beside ⌘P). Every editor that has chords
spends ⌘K as the prefix, and this app has already spent it. Options: keep
⌘K for the palette and use another prefix; or make ⌘K the chord prefix and
let the palette keep ⌘P/⌘⇧P alone. The second is what the muscle memory of
every VS Code hand expects, and ⌘P already opens the same box. Decide in
this plan's first commit, not mid-implementation.

**Conflict rules extend, not change:** the sheet already refuses a binding
that another command holds. Two more refusals: a chord whose prefix is
another command's whole binding (the prefix would swallow it), and a single
binding equal to an existing chord's prefix (same problem, other direction).
Both are the same sentence the sheet already says, with a different clause.

## Editor-local keys join the sheet, read-only

The plan's open question — does the registry cover bold and italic — has a
cheap honest answer: list them in the sheet's fixed section the way the
contextual keys are listed, sourced from a small hand-kept table, and do not
make them rebindable. They belong to Milkdown and CodeMirror; the sheet's
job is to stop being *incomplete*, not to own them. The day someone actually
asks to rebind bold is the day that trade gets revisited.

## Keybinding packs — the shape exists, unbuilt

`keyOverrides` is `{ [commandId]: keys }` merged over defaults. A pack is
the same shape with a different source. Nothing to build until a second
keymap someone wants actually exists; noted here so nobody designs a new
mechanism for it.

## Still not this plan

Vim/modal editing stays a different feature — it lives inside the editor
surfaces, not the app's keydown handler, and would arrive as a CodeMirror/
Milkdown extension. If it is wanted, it gets its own seed.

## Next

- [ ] Decide the prefix: ⌘K moves to chords (palette keeps ⌘P/⌘⇧P), or a
  different prefix — written down before any code
- [ ] `matchKeys`/`specFrom`/`renderKeys` learn the two-step spec
- [ ] `pendingChord` in the keydown lookup, with the timeout and the
  status-bar indicator
- [ ] Sheet capture takes chords; the two new conflict refusals
- [ ] Editor-local keys listed in the sheet's fixed section
- [ ] First real chords, from the pressure that exists today: candidates are
  the ⌘W family (close tab / close pane / close all) and the view
  overrides that currently ride on ⌥-click

