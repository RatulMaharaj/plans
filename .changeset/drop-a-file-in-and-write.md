---
"plans": minor
---

Drag a markdown file from Finder onto the window and it opens, editable, and
saves back to where it came from. A file that lives inside an open repository
opens as that repository's file, diff and all; one from anywhere else opens
with its folder as its root — the watcher, autosave and the conflict check
all work, because they only ever needed a directory and a name. Its view
switch offers Write and Source and no Diff, since there is no commit to
compare against. A dropped folder is the add-a-repository gesture by other
means; anything that isn't markdown is declined by name.

This turns Tauri's own drag-drop handling on, which is what makes real
filesystem paths — and therefore editing in place — possible at all.
