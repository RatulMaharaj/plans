# Agents That Flesh Out Plans

The plans in this folder are written by an agent. That happens in a terminal,
in another window, pointed at the same repository the app has open — the app
watches the files change and shows the result, but has no part in producing it.

The goal: start that work from the app, on the plan that is already open,
without leaving it.

The draft asks the right question and does not answer it: embed a terminal, or
wrap the whole thing in UI? The answer here is *neither, yet* — and the reason
is the interesting part.

## The app is already the review surface

Everything that happens after an agent runs is already built:

- The poll picks up files changed underneath the app (`watchSeconds`,
  `settings.ts`, 4s by default)
- The conflict path handles a file that moved while it was open
  (`App.tsx:488`) — nothing gets clobbered, the reader chooses
- The diff view shows what changed against the last commit
- The git panel stages, commits, and pushes it

An agent that writes markdown into the repo is, from the app's side, just
another editor of the same files — the case the app was already built to
survive. So the feature is not "show an agent"; it is **start one, and get out
of the way**. That reframing is what keeps this small.

## The smallest true version

One action — *Flesh out this plan* — on the open file:

- A palette command in `Palette.tsx`, and a button in the page header next to
  the view switch (`App.tsx:1514`)
- Runs the agent headless against the repository, with the plan's path as the
  subject
- While it runs: the existing `busy` indicator in the status bar
  (`App.tsx:1711`), the same one git operations use through `onRun`
  (`App.tsx:1120`)
- When it finishes: the poll shows the new text, and the reader opens the diff

No new panel, no new view, no output window. If the run fails, the toast says
so with the agent's stderr, exactly as a failed `git push` does.

### Rust side

New commands in `lib.rs`, alongside the existing set, following the shape of
the `git()` helper (`lib.rs:27`) — explicit argv, no shell, repo as cwd:

- `agent_available() -> Option<AgentInfo>` — resolved binary path and version,
  so the UI can hide the action rather than fail on press
- `run_agent(repo, rel_path, prompt) -> RunId` — spawns the agent, returns
  immediately
- `cancel_agent(run_id) -> ()` — a long-running child process the app cannot
  stop is a process the reader has to find in Activity Monitor

`git()` is synchronous and returns a `String` because git commands finish in
milliseconds. An agent run takes minutes, so this is the app's first genuinely
long-lived child process, and the first thing that needs to stream rather than
return: progress goes back as Tauri events, which means `lib.rs` grows a
`setup` hook and `.manage(...)` state it does not have today. That is the same
structural addition [`4_auto-updates.md`](./completed/4_auto-updates.md) needs, and either
one can land it.

## On embedding a terminal

A real terminal — PTY, `xterm.js`, ANSI, resize, scrollback — is a genuinely
useful thing for this app to have, and it is a separate feature. It should not
arrive as an implementation detail of "run an agent", because then its scope is
set by that one use and it ends up a bad terminal.

It is also not small. Tauri has no shell/PTY plugin in this project today
(`Cargo.toml` has `opener` and `dialog`), so it means a PTY crate, a bridge to
the frontend, and a terminal emulator in the bundle — against an app whose
entire Rust surface is currently file reads and `git` subprocesses.

The case *for* it is real: agents ask questions, and a headless run either
can't answer them or answers them by guessing. That is the one thing the
smallest version above genuinely cannot do.

So: build the headless action first, use it, and find out whether the questions
matter in practice. If they do, the terminal is the answer and it will have
earned its scope. If they don't, it was never needed.

## Trust

Running a coding agent over the open repository is arbitrary code execution
with write access, started by pressing a button in a text editor. This is the
same question [`1_formatters.md`](./1_formatters.md) raises about executing
`node_modules/.bin/prettier`, one step further along — the formatter rewrites
whitespace, the agent rewrites the repository — and it should get the same
answer, in the same place, rather than a second mechanism.

- Off by default, enabled per repository, with a prompt naming the resolved
  binary
- Never installs anything, never runs through a shell
- The action only ever targets a path inside the repo, through the existing
  `safe_join` guard (`lib.rs`)
- Nothing is committed automatically. The agent writes files; a person reads
  the diff and commits. That boundary is the whole safety story, and the app
  already has both halves of it

Worth being explicit about one thing: an agent can change files far outside the
plans folder. The app's tree only shows markdown, so the git panel is the only
place a stray edit to `src/` would surface. That is an argument for the git
panel being the natural landing place after a run, not the diff of the one
file.

## Open questions

- **Which agent?** Hard-coding `claude` is honest about what this repo actually
  uses; a configurable command in settings is one line and invites everyone
  else's. Probably: default to `claude`, allow an override, resolve it the way
  `1_formatters.md` resolves a formatter binary.
- **What is the prompt?** "Flesh out this plan" is the obvious one, and this
  folder now has a house style worth naming in it — the plans reference
  `file:line`, keep open questions, end in a `Next` checklist. That prompt is
  itself a thing to version in the repo.
- Should the run stream its output anywhere at all, or is a spinner and a diff
  genuinely enough? A quiet minutes-long operation with no output is
  indistinguishable from a hung one.
- What happens if the reader edits the file while the agent is writing it? The
  conflict path handles it correctly, but firing a conflict dialog over the
  app's own action is a poor experience — probably the file should be read-only
  in the editor for the duration.
- Is this one action, or the beginning of a set (*flesh out*, *find the bugs*,
  *split this into two plans*)? A set wants a menu, and a menu wants a panel,
  and that is how this becomes the UI it was trying not to be.

## Next

- [ ] `agent_available()` — resolve the binary, hide the action when absent
- [ ] Long-running child process plumbing: `setup` hook, managed state, cancel
- [ ] `run_agent` with the prompt in the repo, spawned with explicit argv
- [ ] The palette command and header button, reusing `busy` and the toast
- [ ] Per-repo trust prompt, sharing the mechanism from `1_formatters.md`
- [ ] Lock the buffer while a run touches its file
- [ ] Land on the git panel when a run finishes, not the single-file diff
- [ ] Use it for a real plan; decide from that whether a terminal is needed
- [ ] <br />
