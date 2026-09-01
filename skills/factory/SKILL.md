---
name: factory
description: Set the software factory up in a repository - the reusable workflows that turn a plan flipped to ready into a reviewed, merged pull request. Use when asked to configure the factory, add the factory action, or make ready plans build themselves in CI.
---
# Configuring the factory

The factory's machinery lives in one canonical repository:
**`github.com/RatulMaharaj/factory`** - reusable workflows, the gate script,
the push wrapper, the review poster and the pr/plans skills the dispatched
agent reads. A repository joins the factory by adding **three thin caller
workflows and three secrets**. It copies no scripts, because every job
checks the factory repo out at `.factory/` and uses the canonical copies.

## Install

1. Copy the three files from the factory repo's `templates/` directory into
   the repository's `.github/workflows/`:
   - `factory.yml` - dispatch on `ready` flips (any branch)
   - `factory-review.yml` - Codex review + auto-merge of factory PRs
   - `factory-commands.yml` - `/factory review` and `/factory implement`
     comments
2. Adapt the `with:` inputs to the repository, reading its CI rather than
   guessing: `runner` (match its CI), `setup` (toolchain provisioning),
   `verify_tools` (its smallest real checks, as scoped `Bash(...)` allowlist
   entries), `ci_workflow` (the CI workflow's name, for the merge gate), and
   `machine_account` if a machine GitHub account authors the factory's PRs.
3. Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`),
   `CODEX_AUTH_JSON` (`codex login`, then `~/.codex/auth.json`), and
   optionally `FACTORY_PAT` (a machine account's fine-grained PAT with
   Contents and Pull requests read/write, the account a write collaborator;
   without it, PRs are bot-authored and each needs one workflow-approval
   click). You cannot create secrets for the owner; say plainly what is
   missing and verify with `gh secret list` when you can.
4. Repository settings: Actions must be allowed to create and approve pull
   requests (Settings → Actions → General). On a personal repo, a branch
   ruleset requiring pull requests will block the claim flip. The pr skill's
   unclaimed mode covers that case, but say so; `deletion` and
   `non_fast_forward` rules cost the factory nothing.
5. The repository needs a `plans/` folder following the plans skill's
   conventions. If the Looped Plans app manages this repo, its bundled skills are
   already installed; otherwise the conventions are in the factory repo's
   `skills/` directory.

## Prove it, cheaply

Push a change under `plans/` that flips nothing to `ready`. The Factory run
should appear, the gate should print an empty unit list, and the paid job
should skip; green in seconds. A full rehearsal is flipping one small plan
`ready` and watching it become a reviewed, merged PR. Leave that to the
owner unless asked, because every dispatch is a paid run.

## What to say to the owner

Installing the review workflow changes the oversight contract from "a human
clicks merge" to "a human reads what merged": a clean Codex verdict plus
green CI merges without a click. Name that trade rather than letting the
default decide. And versioning: callers reference `@main`, so factory-repo
updates reach every caller on its next run. Pin to a tag for repos that
should update deliberately.
