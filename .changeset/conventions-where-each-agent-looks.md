---
"plans": patch
---

"Install skill" wrote `.claude/skills/plans/SKILL.md` — Claude Code's location
and nobody else's. The chat starts Codex, Gemini and OpenCode just as readily,
and none of them will ever read that file, so for three of the four agents the
button was a no-op with a reassuring label.

The conventions now go wherever the agents on this machine actually look:
Codex and OpenCode read `AGENTS.md`, Gemini reads `GEMINI.md`, Claude Code
reads its skills directory. One text, a table of addresses — the conventions
are the same conventions whoever is reading them. Only for agents this machine
has, since a `GEMINI.md` arriving in the git status of someone who has never run
Gemini is litter.

A repository that already has an `AGENTS.md` does not lose what was in it. A
file under a tool's own dotted directory exists because the tool does, so the
app owns it and replaces it; a file at the root of the repository belongs to the
repository, and only the app's own fenced section is rewritten.

The settings row names the agents rather than a path, which is the part of this
the reader can actually act on.
