---
"plans": minor
---

`plans .` in a terminal now opens that repository in the app. Settings →
Repositories has an Install button that puts a small `plans` script on your
PATH (Homebrew's bin, or /usr/local/bin); the script launches the app with the
path and gives the terminal its prompt back.

If Plans is already running, a second `plans <path>` doesn't open a second
copy — the running window is focused and the repository is added there, by way
of the new single-instance plugin.
