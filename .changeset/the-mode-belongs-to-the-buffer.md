---
"plans": minor
---

Write, source, and diff are now remembered per buffer rather than being one
app-wide switch: flip a file to source, click another tab, and each keeps its
own mode — across restarts too. The three buttons moved up into the tab row,
pinned right while the tabs scroll, and opening a file from the git panel
lands in its diff without disturbing any other buffer's mode. Settings is no
longer a view of a buffer, so opening and closing it touches nothing.
