---
"plans": minor
---

The view switch is one global state: Write, Source and Diff set both panes
at once — and ⌥-click (or the palette's "This pane" commands) pins only the
focused pane, so the same file can sit rich on one side and raw on the
other. When both panes hold one file they mirror instantly: the pane being
typed in owns the buffer and the save, the raw views follow per keystroke,
the built page follows on a short trailing debounce, and the other pane's
autosave is adopted quietly instead of rebuilding the reader's view.

The pointing routes filled in: right-click a file in the tree for "Open to
the side", right-click a tab in either strip to move it across or close it.
The drop zone stays away once a split exists (the pane itself is the target
— nothing promises a third pane), a drag from the split outlines the main
pane as its target the way the split is outlined for drags the other way,
and the bright active-tab indicator follows the pane the keystrokes actually
go to.
