---
"plans": minor
---

The app now ships a second skill: a review skill that teaches any agent how to
turn a branch or PR into review materials a human can actually digest — a
small numbered set of documents split by what the reader does, mermaid where
prose loses, code blocks as quotations with `file:line`, and statuses that
make the tree a reading checklist.

Install conventions installs every bundled skill everywhere the agents on
this machine look: Claude Code gets a file per skill under `.claude/skills/`,
and the agents that read `AGENTS.md` or `GEMINI.md` get a fenced section per
skill — the existing plans fence keeps its bare spelling, so nothing already
installed stops matching. The palette gains an "Open the … skill" command per
installed skill, with the honest caveat that these copies are rewritten on
update.
