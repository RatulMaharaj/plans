---
status: done
---
# Agent UX Bake-off

The app can start an agent on a plan and show the run in a real terminal
(`plans/tmux-sessions.md`). Whether a terminal is the *right* way to live with
agents is a different question, and it is not answerable by argument — it is a
feel question, and feel questions are answered by using the thing. So: four
interaction models, each planned and built for real in its own worktree, tried
blind, one kept.

## Method

Each variant lives in a worktree under `~/Projects/plans-variants/{a,b,c,d}`,
branched from the terminal build and carrying one interaction model. The
letters are shuffled against the concepts below, and the mapping lives in
`~/Projects/plans-variants/MAPPING.md` — do not open it, or the variant's own
plan file, until after trying that variant. Launch each with
`pnpm app` from its directory, one at a time (they share port 1420), use it
for a real session — start a run, answer a question, come back later — and
only then read what it was.

Judging is deliberately soft: which one did you stop noticing? Which one did
you *reach for* rather than remember to check? The winner's plan graduates to
`plans/`, the others' become `plans/completed/` notes on why not.

## The four models

Named here by concept, not by letter — the shuffle is the blindness.

- **Terminal**: the run is a place you visit. A real attached terminal in the
  panel; you go to the agent. Already built on `main`; one worktree simply
  pins it so it is tried under the same blind conditions as the rest.
- **Chat**: the agent is someone you talk to. A conversation panel per plan —
  you type, it answers, the transcript persists. The run's machinery is
  invisible; only the exchange remains.
- **Inbox**: agents are things that report to you. No live screen at all —
  runs appear as cards with a status (working / needs you / done), a tail of
  recent output, and a one-line reply box. Built for six agents at once, and
  for coming back after an hour.
- **Margin**: the agent lives in the document. You point at the text — a
  selection, a heading — say what you want there, and the answer *is the
  edit*, arriving through the file watcher and the diff view like any outside
  change. The conversation is the document changing.

Each worktree carries its own `plans/agent-ux-variant.md` arguing that model's
design honestly — including what it is bad at.

## What makes this a fair fight

- All four sit on the same substrate: tmux owns processes (`mux.rs`), plans
  stay files, nothing commits for you. No variant gets to cheat by being the
  only one whose runs survive an app restart.
- All four are entered the same way — the "Flesh out" affordance and ⌘J — so
  the difference under test is the interaction, not the entrance.
- Real work only: each must survive an actual agent session on this repo, not
  a demo script.

## Open questions

- Is one session per variant enough, or does novelty need a week to wear off?
  A model can charm for an hour and grate for a month.
- Do two of these want to *merge* — an inbox whose cards open into a
  terminal, a chat whose answers are margin edits? The blind trial ranks
  pure forms first; hybrids are a second round if two models tie.
- Does the loser's machinery get deleted, or kept behind a setting? The
  precedent in this repo is deletion — stranded halves of features are how
  `api.ts` grows barnacles.

## Done when

- Four worktrees launch, each a complete, working interaction model.
- The mapping stayed sealed until after each trial.
- One model is chosen, its plan graduates, and the others are written up and
  removed.

## Next

- [ ] Worktrees `a`–`d` created from the terminal build, letters shuffled
- [ ] Chat variant built and self-tested in its worktree
- [ ] Inbox variant built and self-tested in its worktree
- [ ] Margin variant built and self-tested in its worktree
- [ ] Trial each blind, in whatever order, one real session per variant
- [ ] Pick, graduate the winner's plan, retire the rest
