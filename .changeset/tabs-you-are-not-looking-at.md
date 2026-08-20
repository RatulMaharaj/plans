---
"plans": patch
---

A file open in another tab that changes on disk now says so, with a dot beside
its name in the tab row.

Only the active file was ever checked for outside edits, so a plan rewritten by
an agent or by a `git checkout` sat there unremarked until you happened to click
back to it — which is the worst moment to be told, since the change is old by
then. A background tab holds no text and re-reads from disk when you open it, so
there was never anything to reload; what was missing was only the telling.

The check runs on the slow tick rather than the watch interval, for the same
reason the tree walk is staggered: a `stat` per open tab is cheap but not free,
and none of this is urgent.
