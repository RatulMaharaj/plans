---
"plans": patch
---

The status vocabulary is now the lifecycle the files actually live: `draft`
(a human wrote a seed, an agent should flesh it out), `ready` (fleshed out,
implementation can start), `busy` (a session is on it now), `done`. An
uncustomised saved status list migrates to the new default; edited lists are
untouched. The conventions ship in the repo as `skills/plans/SKILL.md` so
agents can read them.
