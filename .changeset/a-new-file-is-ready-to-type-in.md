---
"plans": patch
---

Naming a new file now leaves the cursor in it, in the empty line under the
heading. Creating a file used to leave you looking at it rather than writing in
it, so the first thing you did after making one was click into it.

The cursor is asked for, not placed. Opening a file only requests the state
change that leads to the editor swapping its document, so focusing at the point
of asking lands in the file you were reading before — which the swap then throws
away. The request is left for the editor and honoured once the new document has
settled, including on the path where the file is the first one opened and the
editor is being built for it rather than swapping.

Only creating a file does this. Clicking through the tree to read something
still leaves the cursor where it was.
