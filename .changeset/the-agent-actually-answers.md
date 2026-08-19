---
"plans": patch
---

The chat could produce nothing but your own message when the app was started
from Finder rather than a terminal: a GUI app inherits launchd's PATH, which
holds none of the places an agent CLI is actually installed. The binary is now
resolved through your login shell's PATH, so the app finds what your terminal
finds.

The narration reads like the terminal too. A tool call shows what it touched —
"Read plan.md", "Bash pnpm test" — rather than a bare tool name, and a turn
that fails says so in the transcript instead of only in a toast that is gone
by the time you look back.

The update banner's two actions are spaced apart, and its labels no longer
break across lines.
