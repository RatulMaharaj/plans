---
status: done
---
# Install The Conventions Where Each Agent Looks

"Install skill" writes `.claude/skills/plans/SKILL.md` (`skill.ts:9`). That is
Claude Code's location and nobody else's. The chat now starts Codex, Gemini or
OpenCode just as readily, and none of them will ever read that file — so for
three of the four agents the button is a no-op with a reassuring label.

## What each one actually reads

Worth checking rather than assuming; the conventions move. As of writing:
Codex reads `AGENTS.md`, Gemini reads `GEMINI.md`, and `AGENTS.md` is the
emerging cross-agent convention that several tools now honour. Claude Code
reads both `CLAUDE.md` and the skills directory.

## The shape

The bundled text is one file (`skills/plans/SKILL.md`, imported at build time)
and should stay one file — the conventions are the same conventions whoever is
reading them. What differs is only where a copy goes.

So: a table beside the agent catalogue in `discover.rs`, mapping an agent to
the paths it reads, and an install that writes the same text to each. The
settings row then says which agent it is installing *for*, rather than naming
a path and hoping.

## Open questions

- One button per agent, or one button that writes every location? Writing
  files an agent will never read is litter; asking four times is a chore.
  Probably: write for the agents you have installed.
- Is `AGENTS.md` enough on its own now? If most agents honour it, the honest
  answer may be to write that and let Claude Code's skill file be the special
  case rather than the default.
- Overwriting: the existing install overwrites and leaves the change as a git
  diff, which is right for a file the app owns. `AGENTS.md` is a file the
  *repository* owns and may already have content — appending a section is a
  different operation from replacing a file, and needs its own thought.

## Done when

- Installing the conventions puts them where the agent you are using looks.
- The settings row names the agent, not a path.
- A repository with an existing `AGENTS.md` does not lose what was in it.

## Next

- [ ] Confirm what each supported agent reads today
- [ ] A paths-per-agent table beside `KNOWN` in `discover.rs`
- [ ] Decide append-vs-replace for repository-owned files
