---
"plans": minor
---

"Flesh out" is now "Hand off to agent", and it lives where you would look for
it: the right-click menu on a plan in the tree, as well as the palette. Handing
off a plan that is not open opens it first, so the turn lands in that plan's
conversation rather than whichever one was on screen. Settings → Agents calls
the instruction the Handoff prompt.

Settings also stops offering what it has already done: the CLI and skill
buttons read the state first and say "Installed", or offer "Update" when the
copy on disk is from an older build.

The chat agent is picked from a list of the ones found on the machine rather
than typed. An agent that is installed but does not speak Claude Code's
streaming flags is offered with a note saying so, rather than silently
failing when spoken to.
