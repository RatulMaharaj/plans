---
"plans": patch
---

Diff is no longer a mode you switch an editor into. The Diff button, ⌘3 and
the palette entry are gone; the view switch is Write and Source. The diff
still exists where it means something — click a changed file in the git panel
and it opens as that file's diff, and a conflict's "See the diff" still shows
yours against the last commit. While a buffer is showing a diff, a lit Diff
segment appears on the switch so there is a way to read the state and a way
back out.

Comments also now land at the cursor — in whichever paragraph it sits, right
where you pointed — rather than being appended after the paragraph's end.
