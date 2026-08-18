---
"plans": minor
---

Each repository row in settings gains an "Install skill" action, which writes
the plan-writing conventions — frontmatter rules and the draft/ready/busy/done
lifecycle — to `.claude/skills/plans/SKILL.md`, where coding agents discover
them. The text is bundled from the canonical `skills/plans/SKILL.md` at build
time; installing over an edited copy overwrites it, leaving the change as a
reviewable git diff.
