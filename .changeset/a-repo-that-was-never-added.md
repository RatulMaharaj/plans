---
"plans": patch
---

Fixes three ways the window could go blank. The first status poll of a
repository compared the new status against one that did not exist yet and
threw; a file opened from a path that was never added to the list took the
diff view down with it; and an unfinished merge or rebase is now said out
loud in the git panel — conflicted files get their own mark in the tree and
their own list, with pull and push held back until the merge is finished.

The view switch moved from the tab row up into the rail.
