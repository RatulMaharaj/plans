---
status: done
---
# How claude-code-action Runs Headless, And Our Local Translation

Research brief for [`github-actions-agents.md`](./github-actions-agents.md):
a read of `anthropics/claude-code-action`'s source (shallow clone, 2026-08-21)
answering the questions the worker needs settled before it exists —
permission strategy, tool allowlist, model and prompt plumbing, run bounds.

## What the action actually does

**It never bypasses permissions.** The plan guessed
`--dangerously-skip-permissions`; the action's battle-tested answer is
`--permission-mode acceptEdits` plus a scoped allowlist
(`src/modes/tag/index.ts:186`). `acceptEdits` auto-allows file edits *inside
the workspace* and denies them outside; `Edit`/`Write` are deliberately left
off the allowlist so the mode, not a blanket grant, is what permits writes —
listing them would grant write access to the whole runner (their comment cites
a real incident). Anything that falls through to "ask" is simply denied,
because headless has no prompt handler. Denial-not-hang is the property our
fail-loudly rule wants.

**The allowlist is small and scoped.** Read-only tools bare
(`Glob, Grep, LS, Read`), Bash granted per-command with scoped patterns:
`Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git rm:*)`. `WebSearch` and
`WebFetch` are disallowed by default.

**`git push` goes through a wrapper script**, not `Bash(git push:*)`
(`scripts/git-push.sh`): exactly two args, no flags, remote must be `origin`,
ref validated. Reason: `git push --receive-pack='sh -c ...'` is arbitrary
code execution, so `git push:*` in an allowlist is an RCE grant (their
HackerOne #3556799). Worth copying verbatim.

**Model and prompt plumbing.** The prompt is written to a file and fed to the
Agent SDK's `query()`; user `claude_args` are parsed shell-style and passed
through as `extraArgs`, with `--model`, `--max-turns`, `--allowed-tools`
extracted and merged (`base-action/src/parse-sdk-options.ts`). System prompt
defaults to the `claude_code` preset. Settings are seeded by writing
`~/.claude/settings.json` before the run
(`base-action/src/setup-claude-code-settings.ts`).

**Run bounds.** `--max-turns` is the run bound, and it is enforced twice: as
an SDK option and again after the fact — a "success" whose turn count
exceeded the max is converted to a failure (`run-claude-sdk.ts:241`).
Likewise `subtype: success` with `is_error: true` is treated as failure, so
CI never shows a misleading green. Session transcript messages are collected
into an execution file per run — their flight recorder, same idea as our
per-run logs.

**Loop guard.** Agent mode refuses to run when the triggering actor is a bot
(`checkHumanActor`), on top of `GITHUB_TOKEN`'s recursion guard — the hazard
the plan flagged for the Action host is real enough that they defend it
twice. Environment is scrubbed of OIDC token-minting variables before the
agent sees it.

## The local translation

The worker's invocation, copying the allowlist stance rather than bypassing:

```sh
claude -p "$(cat prompt.txt)" \
  --model "$MODEL" --effort "$EFFORT" \
  --permission-mode acceptEdits \
  --allowedTools "Glob,Grep,LS,Read,Bash(git add:*),Bash(git commit:*),Bash(git rm:*),Bash(git worktree:*),Bash(git fetch:*),Bash(git checkout:*),Bash(scripts/git-push.sh:*),Bash(gh pr create:*)" \
  --disallowedTools "WebSearch,WebFetch" \
  --max-turns "$MAX_TURNS"
```

- **Bypass is off the table.** `acceptEdits` + allowlist gives the skill
  everything it needs (edit in the worktree, scoped git, `gh pr create`) and
  a denied tool call fails the run loudly instead of hanging — strictly
  better than `--dangerously-skip-permissions` on both safety and the
  fail-loudly rule. The plan's "where it uses an allowlist, copy it" clause
  triggers.
- **Ship a `git-push.sh` twin** and allow it instead of `git push:*`. Ours
  additionally refuses to push the default branch unless the diff is a
  lone status flip — mechanical enforcement of the claim exception.
- **`--effort` is a real flag** in the installed CLI (`claude -p --help`
  lists it), so the plan's open question closes the easy way: frontmatter
  `effort` passes straight through, no settings-file workaround.
- The allowlist needs the repo's verify commands too (e.g.
  `Bash(npx playwright test:*)` here) — that is per-repo worker config,
  beside default model and effort.
- **Bound every run**: `--max-turns` from config, a wall-clock timeout
  around the process, and stdout/stderr to a per-run log file — the
  cheapest flight recorder, exactly as the plan's endpoint section assumed.
- **Treat exit status skeptically** the way they do: worker marks a run
  failed unless the process exited zero *and* the expected artifacts exist
  (branch pushed, PR opened, or plan back at `ready` with a note).
