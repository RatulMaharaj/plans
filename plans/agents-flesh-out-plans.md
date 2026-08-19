---
status: busy
---
# Agents That Flesh Out Plans

The plans in this folder are written by an agent. That happens in a terminal,
in another window, pointed at the same repository the app has open — the app
watches the files change and shows the result, but has no part in producing it.

The goal: start that work from the app, on the plan that is already open,
without leaving it.

The draft asks whether to embed a terminal or wrap the whole thing in UI. The
answer is **neither: start it in tmux.** The app never becomes the agent's
parent process. It builds an argv, opens a window in the repo's tmux session,
and goes back to being what it already is — the place you read the result.

That makes this plan thin, because the hard half lives next door.
[`tmux-sessions.md`](./tmux-sessions.md) is where panes are discovered, read and
typed into; this plan is one caller of `mux_start`.

## The app already assumed this

The poll loop says so itself, in a comment written before any of this:

```ts
// Files written by Claude Code in a terminal should turn up on their own.
```
— `App.tsx:605`

Everything after a run is built:

- The tree and git poll pick up files changed underneath the app
  (`App.tsx:605`, `watchSeconds` in `settings.ts:113`, 4s by default)
- The open file is stamped every tick and reloaded when it moves
  (`App.tsx:1028`)
- The conflict path handles a file that changed while it was open and dirty
  (`App.tsx:1049`) — nothing gets clobbered, the reader chooses
- The diff view shows what changed against the last commit
- The git panel stages, commits, and pushes it

An agent that writes markdown into the repo is, from the app's side, just
another editor of the same files — the case the app was already built to
survive. So the feature is not "show an agent", and it is not even "run an
agent". It is **stop making you leave the app to type the command.** That
reframing is what keeps this small.

## Not a built-in agent, and not a background one

Two constraints, and they are the same constraint:

**Nothing runs without oversight.** An agent rewriting the repository while a
spinner turns in the status bar is the app doing something consequential where
it cannot be watched, corrected, or answered. Agents ask questions. A headless
run either cannot answer them or answers them by guessing, and the first you
learn of the guess is in the diff.

**The agent is not ours to choose.** `claude`, `opencode`, `codex`, `pi` — the
app should shell out to whichever one you use, not ship an opinion about it.

Starting into tmux satisfies both. The run is a real pane: interactive,
cancellable with `⌃C`, with its own scrollback, alive whether or not Plans is.
The app needs no spinner, no cancel command, and no policy for what to do when
the agent asks a question — tmux has all three, and the session pane means you
can see and answer it without leaving.

## The smallest true version

One action — *Flesh out this plan* — on the open file, in two steps, the first
of which is useful on its own.

**Step one: copy the command.** Build the argv from the active file, put it on
the clipboard, and toast it. No new Rust, nothing spawned, and it proves the
command template is right before anything runs it. This is worth shipping alone.

**Step two: run it.** `mux_start(repo, argv)` from
[`tmux-sessions.md`](./tmux-sessions.md) — a `new-window -d` in the repo's
session, returning the new pane's id. `-d` means your focus stays here. The call
returns in milliseconds and the app stores the pane id, which is the handle the
session pane uses to show you the run.

There is nothing else to build here. No `open -a`, no per-terminal launch flags,
no temp script — all of that was the cost of not having a session layer.

Two surfaces, both offered on any plan:

- A palette command inside `buildCommands` (`Palette.tsx:105`), behind
  `p.canEdit` — the flag the frontmatter and status commands already use
  (`Palette.tsx:120`)
- A button in `page-actions` (`App.tsx:1883`), beside the Write/Source/Diff
  switch (`App.tsx:1905`)

`onRun` (`App.tsx:1475`) is still the right wrapper for the launch — it is a
subprocess that returns immediately, toasts on failure, and refreshes after,
which is exactly what every git command does. What it is *not* is a progress
indicator for the agent. The `busy` state (`App.tsx:156`, rendered at
`App.tsx:2124`) covers the launch and nothing beyond it.

## Not gated on status

The tempting version shows the action only on a plan that is `draft` or
`triage`. `statusTone` (`matter.ts:107`) already rules against it:

> the app reads conventions, it doesn't own a vocabulary

The status list is yours — `settings.statuses` is a plain editable string
(`settings.ts:113`, edited as chips through `TagsField`,
`SettingsPage.tsx:274`), and `statusTone` recognises five names only to pick a
colour, falling through to `other` for everything else. Gating an action on
those five would make the app own the vocabulary it deliberately refuses to own,
and hide the action from anyone whose list we cannot predict.

So it is offered on every plan. Running it on a `done` one is a decision the
reader is allowed to make.

This also removes the reason to build a "New plan" that writes frontmatter:
with no gate, nothing depends on a status existing. `create_plan`
(`lib.rs:599`) can go on writing `# {title}\n\n` and leaving the block to
`scaffoldMatter` (`App.tsx:932`).

## Which agent

Both are settings, and the first is a **command template** rather than a binary
name, because no two agents take a prompt the same way:

```
agentCommand: "claude {prompt}"     // {prompt}, {file}, {repo}
```

Add the key with its doc comment to `Settings` (`settings.ts:5`) and a value to
`DEFAULTS` (`settings.ts:94`), rendered as a `Field` (`SettingsPage.tsx:505`).
Free text is not expressible through the palette's `toggle` and `nudge`
primitives, so an in-app edit would need the `TextPrompt` / `setAsking` pattern
used for branch and commit names (`App.tsx:1514`) — or it simply lives in
settings, which is where a command line belongs.

There is no second setting for the terminal. tmux is the terminal, and which
multiplexer is a question `tmux-sessions.md` owns.

## On embedding a terminal

Answered, and not here. `capture-pane` gives the app the pane's screen as text
and `send-keys` puts keys back into it — a window onto a terminal, at a fraction
of the cost of a PTY and an emulator. That is `tmux-sessions.md`'s subject, and
it is why this plan needs no output panel of its own.

## Trust

Most of the trust machinery this plan used to borrow from
[`formatters.md`](./formatters.md) is unnecessary here, and it is worth being
clear about why rather than copying it out of caution.

A formatter is an unfamiliar binary, found inside a repo you just opened, run
automatically on every save. That needs a per-repo decision and a prompt naming
the resolved path. This is the opposite on every axis: your multiplexer, a
command you configured yourself, started only when you press the thing, and
visible in a pane while it works. The oversight *is* the safeguard.

What survives is the mechanical part:

- Never through a shell; explicit argv; the repo as cwd via `new-window -c`
- The action only ever names a path inside the repo, through the existing
  `safe_join` guard (`lib.rs:12`)
- Nothing is committed automatically. The agent writes files; a person reads the
  diff and commits. That boundary is the whole safety story, and the app already
  has both halves of it

One thing to keep saying out loud: an agent can change files far outside the
plans folder. The tree only shows markdown, so the git panel is the only place a
stray edit to `src/` would surface. That is an argument for the git panel being
the natural landing place after a run, not the diff of the one file.

## Open questions

- **What is the prompt?** "Flesh out this plan" is the obvious one, and this
  folder now has a house style worth naming in it — the plans reference
  `file:line`, keep open questions, end in a `Next` checklist. That prompt is
  itself a thing to version in the repo, which means the prompt file is the
  first artefact of this feature and can exist before any code does.
- Is this one action, or the beginning of a set (*flesh out*, *find the bugs*,
  *split this into two plans*)? If it is a set, `agentCommand` should be a list
  of named commands rather than one string — and that changes the setting's
  shape, so it is worth deciding before building the single-string version.
- What happens when there is no tmux server running at all — the first run of
  the day, before you have opened a terminal? `new-window` will start one, which
  is probably right, but it means Plans can be the thing that creates your
  session. Worth deciding rather than discovering.
- Should the launch pass the plan's path, or its contents, or neither and let
  the agent find it? Passing the path is the honest minimum, and `new-window -c`
  fixes the cwd so a repo-relative path is unambiguous.
- Does anything want to know a run is in progress? With the session pane open
  you can see it; with it closed the app knows only that a pane exists and is
  not running a shell. Resist making that into a status indicator that claims
  more than tmux can actually tell us.

## Next

Depends on [`tmux-sessions.md`](./tmux-sessions.md) for `mux_start`; everything
before that is independent of it.

- [x] The prompt lives in the repo, as `FLESH_OUT_PROMPT` (`src/agent.ts`)
- [x] Build the command from the active file and copy it to the clipboard
      ("Copy the agent command" in the palette)
- [x] `agentCommand` in `Settings` and `DEFAULTS`, with a `Field` in settings
- [x] The palette command and the header button in `page-actions`
- [x] The button calls `mux_start` and keeps the pane id it returns, opening the
      pane on it
- [ ] Land on the git panel when the files change, not the single-file diff
- [ ] Use it for a real plan, and see whether one action wants to be a set
