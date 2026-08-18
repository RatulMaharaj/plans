---
status: done
---
# Esc Unfocuses the Editor

While the cursor is in the document, the app's shortcuts are dead. That is
deliberate — ⌘B has to mean bold inside ProseMirror — but the only way back
out is to click on chrome. Esc should hand focus back to the app, and the tab
should show which of the two states you are in.

## Why ⌘B does nothing while writing

There is one global keydown handler (`App.tsx:1561-1670`). Near the top of the
shortcut section it probes where focus is:

```ts
const inEditor = !!(document.activeElement as HTMLElement | null)?.closest(
  ".milkdown, .source, .diff-surface",
);
if (inEditor && !e.ctrlKey) return;
```

Nothing ever clears that condition from the keyboard. The existing Esc
branches (`App.tsx:1648-1652`) handle only zen mode and the settings page, so
once you are typing, `activeElement` stays inside `.milkdown` until a mouse
click.

## The fix

Two pieces, and the first makes the second cheap.

**Track focus as state rather than probing.** Add an `editing` boolean in
`App`, driven by `focusin`/`focusout` on the two surface wrappers
(`App.tsx:2045` and `2064` — the wrappers around the write/source and diff
surfaces). Debounce nothing; `focusin` bubbles and the wrappers contain every
editable surface. Then the shortcut guard reads `editing` instead of walking
`document.activeElement`, which also makes it testable.

**An Esc branch.** Before the zen/settings branches (~`App.tsx:1648`): when
`editing` is true, `(document.activeElement as HTMLElement)?.blur()`, move
focus somewhere sensible in the chrome (the active tab button is the natural
target — it is what the visual clue points at), `preventDefault`, and stop.
Ordering matters only in one place: the palette early-return at `App.tsx:1564`
already eats Esc while the palette is open, which is correct and stays first.

No ProseMirror or CodeMirror keymap is needed. Neither surface calls
`stopPropagation` on Escape, and the App listener is on `window`, so the key
arrives.

## The visual clue

Tabs (`App.tsx:1847-1878`) know only "selected" today: `.tab.on` colours the
name and draws a 2px top rule (`App.css:1562-1620`). There is no
focused-vs-selected distinction anywhere.

Render the active tab with an extra class when the editor has focus:

```tsx
`tab ${on ? "on" : ""}${on && editing ? " editing" : ""}`
```

and style the difference on the top rule — accent when editing, ink when
merely selected — near `App.css:1596`. The rule reads as a cursor for the tab
row: bright means keystrokes go to the document, dim means they go to the app.

## Done when

- Esc while typing blurs the editor; ⌘B then opens the sidebar (or whatever
  ⌘B does in chrome) without a click.
- Esc with the palette open still closes the palette and does not blur.
- Esc in zen mode with the editor focused blurs first; a second Esc leaves
  zen. (Or blur-and-leave together — decide in the diff, but decide.)
- The active tab's rule visibly changes when focus enters and leaves the
  document.
- Clicking back into the document restores editing state and the shortcut
  guard, with no stale `editing` after a file switch.
