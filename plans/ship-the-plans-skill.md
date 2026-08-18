---
status: done
---
# Ship the Plans Skill

The status vocabulary now exists twice: in `statusTone` (`src/matter.ts`) and
in the heads of whoever writes the files. Agents are most of whoever, and they
learn conventions from skills. `skills/plans/SKILL.md` is the canonical text,
shipped in this repo; this plan is about getting it into every *other* repo
the app opens.

The goal: an agent working in any repo that Plans watches knows the frontmatter
rules, the six statuses, and the claim protocol (`busy` before you start,
`blocked` with a reason, never demote someone else's status) — without the
human pasting instructions.

## Approach

Bundle the skill's text with the app and offer to install it, per repo:

- The canonical text lives in this repo at `skills/plans/SKILL.md` and
  is imported into the bundle at build time (Vite `?raw` import), so there is
  one source of truth and the app can never drift from it.
- A repo's settings gain one action: "Install agent skill", which writes
  `.claude/skills/plans/SKILL.md` into that repo. Writing a file into someone's
  repo is a thing they click, not a thing that happens.
- If the file exists and differs from the bundled text, show the diff and offer
  to update — the app already knows how to render a diff.

## How it landed

Implemented in `src/skill.ts` plus an "Install skill" action on each repo row
in settings, writing `.claude/skills/plans/SKILL.md` where Claude Code
discovers skills. The open questions resolved as:

- Settings action only, no proactive offer — writing a file into someone's
  repo stays a thing they click.
- An existing copy that differs is overwritten rather than diffed in a dialog:
  the repo is git, so the change lands as a reviewable, revertable diff, and
  the toast points at the git panel. No version stamp needed for that.
- Repos with a customised status list maintain their own skill by hand; the
  installed text is always the canonical one.
