---
name: factory
description: Set up the Factory GitHub Action in a repository — the workflow that turns a plan flipped to ready into a pull request, headless, using the pr skill. Use when asked to configure the factory, add the factory action, or make ready plans build themselves in CI.
---
# Configuring the Factory action

The factory dispatches on the status flip: a push to the default branch that
flips a plan (or a feature-folder member) to `ready` runs one matrix job per
unit, and each job is a headless agent following the pr skill through to a
pull request. Setting a repository up is installing three artifacts and one
secret, then proving the gate skips when nothing flipped.

## The three artifacts

Canonical copies live in the plans repo
(`github.com/RatulMaharaj/plans`) — if that is the repository you are in,
they are already at these paths; otherwise fetch each from
`https://raw.githubusercontent.com/RatulMaharaj/plans/main/<path>`:

1. `scripts/git-push.sh` — the only push path a dispatched agent is granted.
   Install verbatim, executable. Origin only, no flags, and the default
   branch accepts nothing outside `plans/*.md` — this mechanically enforces
   the claim exception, so never widen it.
2. `scripts/detect-ready-units.mjs` — the gate. Install verbatim,
   executable. It selects units whose status *transitioned to* ready in the
   push (never "all ready plans" — old ready plans must not re-dispatch),
   collapses feature folders to one unit, reads `model`/`effort` frontmatter
   at the highest value any folder member asks for, and degrades invalid
   values to the defaults with a warning.
3. `.github/workflows/factory.yml` — the workflow. Install, then adapt it
   to the repository (below). It is a gate job feeding a
   `strategy.matrix` implement job that runs `anthropics/claude-code-action@v1`
   with the pr skill prompt.

The repository must also carry the plans and pr skills (the Plans app's
Install writes them); a factory without the pr skill has nothing to follow.

## Adapting the workflow to the repository

- **Verify commands.** The allowlist in `claude_args` ends with the plans
  repo's own check commands (`pnpm test`, `tsc`, playwright). Replace those
  entries with the smallest checks *this* repository's CI runs first — read
  its workflow files rather than guessing. Keep the rest of the allowlist
  exactly as shipped: read-only tools bare, git per-subcommand, pushes only
  through `Bash(scripts/git-push.sh:*)`, `WebSearch`/`WebFetch` disallowed.
- **Runner.** Match the repository's own CI runner so the verify step can
  actually run (`ubuntu-latest` unless its CI says otherwise).
- **Defaults.** `env.DEFAULT_MODEL` / `env.DEFAULT_EFFORT` are the fallback
  for plans carrying no hints; set them to what the owner asked for, or
  leave them as shipped.
- **Branches.** The workflow triggers on a plans flip pushed to *any*
  branch, and the pushed branch is the run's base — worktree, claim flip,
  and PR target alike. Leave it unfiltered unless the owner asks to confine
  the factory to specific branches.

Two lines are load-bearing and must survive any adaptation: the implement
job's `if:` on the gate's output (an empty push must cost nothing), and
`github_token: ${{ secrets.GITHUB_TOKEN }}` — the default token is GitHub's
recursion guard, so the claim flip the run pushes cannot retrigger the
workflow. Substituting a PAT there reopens that loop.

## Auth

The action bills the Claude subscription, not an API key: the owner runs
`claude setup-token` locally and saves the result as the
`CLAUDE_CODE_OAUTH_TOKEN` Actions secret. You cannot create this secret for
them; say plainly that the factory will fail at auth until it exists, and
verify with `gh secret list` when you can.

## Prove it, cheaply

After installing, push a change under `plans/` that flips nothing to ready
(or note that the installing commit itself is one). The Factory run should
appear, the gate should print an empty unit list, and the implement job
should skip — green in seconds. That is the factory armed. A full rehearsal
is flipping one small plan to `ready` and watching the matrix job end in a
PR; leave that to the owner unless they asked for it, because every dispatch
is a paid run.
