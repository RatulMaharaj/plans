---
"plans": minor
---

The software factory's first working set. A third bundled skill, `pr`, joins
`plans` and `review` (it slipped into 0.6.0 without a changelog line): how an
agent turns a `ready` plan into a pull request — one unit per run, a pushed
`busy` flip as the claim and lock between workers, a worktree from the default
branch's tip, and fail-loudly back to `ready` as the only exit besides a PR.
Around it, the dispatchers: `scripts/worker.mjs`, a local daemon that watches
configured repos and spawns headless runs — fleshing out `draft` plans and
implementing `ready` ones, so committing a draft is the whole human gesture —
and a Factory GitHub Action that runs one matrix job per unit whose status
*became* `ready` in a push, billed to the Claude subscription. Both route by
the plan's `model`/`effort` frontmatter, both confine pushes to
`scripts/git-push.sh` (origin only, no flags, and the default branch accepts
nothing outside `plans/`), and neither ever bypasses permissions — a scoped
allowlist plus `acceptEdits`, the configuration `claude-code-action` already
battle-tested in public.
