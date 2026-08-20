---
"plans": patch
---

A file can be dragged from one repository into another. The tree refused it
before, on the grounds that it would be a copy rather than a move — which was
true, and is the answer rather than the objection: git has no rename spanning
two repositories, so the destination gets an addition and the original stays
exactly where it was. The cursor says which of the two a drag is while you are
doing it.

The buffer is written out first. The file being dragged may be the one you are
typing into, and the copy happens on disk — without that, what arrives in the
other repository is quietly a few seconds old.

This is the half of "copying files between repos, and dropping files in from
Finder" that costs nothing. The Finder half is a different change: it needs
Tauri's own file-drop handling turned on, which takes away the HTML5 drag
events this feature and the tree's drag-to-move are both built on.
