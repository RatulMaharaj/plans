---
status: done
---
# The Agent Is Someone You Talk To

This variant's bet: the natural unit of working with an agent is not a
process, a pane, or a run — it is a **conversation about the plan you are
looking at**. ⌘J opens a chat under the document. You type, the answer streams
in, and anything the agent does to the files arrives the way every outside
edit always has: through the watcher, the tree marks, and the diff view.

The terminal variant shows you the run's machinery and asks you to like it.
This one hides the machinery and asks whether you miss it.

## The conversation is the CLI's, not ours

The app builds no agent loop. `claude -p` already takes a prompt, `--resume`
already continues a session, and `--output-format stream-json` already
narrates. `chat_send` (`chat.rs:86`) spawns one headless child per turn with
those flags fixed in Rust — the setting is only the binary name
(`settings.ts:81`, default `claude`), because a template would let the flags
drift from the parser that reads the stream. No PTY, no terminal emulation:
stdout is a pipe, and a reader thread turns NDJSON into three events —
`chat-delta` for prose, `chat-tool` when a tool starts, `chat-done` carrying
the session id.

The child is disposable; the **session id is the conversation**. It rides
`--resume` on the next turn, so the transcript the panel shows and the context
the agent holds stay the same thing without the app storing any messages the
agent needs.

`--permission-mode acceptEdits` (`chat.rs:103`) is load-bearing: without it a
headless run cannot edit the plan it is being asked about, and the whole model
collapses into a read-only oracle. With it, "tighten the opening" actually
tightens the opening, and the edit shows up in git like any other.

## The transcript belongs to the plan

The chat is keyed by `(repo, plan)` (`ChatPanel.tsx:35`) and persisted in
localStorage, so switching files switches conversations and reopening a plan
resumes where it left off. Events land in a ref-held map first and only mirror
into React state when their conversation is on screen (`ChatPanel.tsx:64`) —
a turn that finishes after you switched plans still writes to the right
transcript instead of the visible one.

"Flesh out" routes *into* the chat rather than into a tmux window: it seeds
the same `FLESH_OUT_PROMPT` as the first message (`App.tsx:680`), because two
front doors to the same agent is exactly the incoherence this variant exists
to test against. The old command template survives only as the copyable
command for running a plan by hand in a real terminal.

Availability follows the `mux_available` rule: `chat_available`
(`chat.rs:70`) runs `<binary> --version`, and `None` hides the button and the
⌘J panel entirely (`App.tsx:654`) rather than offering a chat that fails when
spoken to.

## What this model is honestly bad at

- **Turns die with the app.** A tmux run survives a restart; a `-p` child
  does not. Quitting mid-answer loses the answer (the session survives, the
  work in flight does not). The terminal variant is strictly better here.
- **It narrates instead of showing.** While the agent rewrites three files
  you see prose and small tool names (`chat-tool` is the one honest peek,
  `chat.rs:121` area) — not the diff growing. The model leans on git to tell
  the truth afterwards.
- **One turn at a time, per plan.** The panel holds a single in-flight turn;
  six parallel agents is the inbox variant's territory, not this one's.
- **acceptEdits is a real capability grant.** The agent can write any file in
  the repo without asking. That is the price of "edit the plan" meaning it.

## Open questions

- Should the transcript render markdown? Answers arrive as prose with real
  formatting; `<pre>`-ish plain text is honest but ugly. Milkdown is heavy
  for bubbles; a tiny renderer might earn its place.
- Is per-plan the right key, or per-repo with the plan mentioned per message?
  Per-plan matches "the chat is about this document"; per-repo matches how
  people actually converse about several files at once.
- Should `chat-done` surface *which files changed* (the CLI's result carries
  usage but not a file list) — probably by diffing `git_status` before and
  after the turn, which the app already knows how to do?
- Cancel kills the child mid-edit. The plan's file is whatever the agent had
  written by then — is that surprising enough to warrant a warning?

## Done when

- ⌘J is a conversation about the open plan; typing gets a streamed answer.
- Asking for an edit changes the file, visibly, through the ordinary watcher
  and git paths — nothing is committed for you.
- Reopening a plan resumes its conversation, machine-side context included.
- Stop ends the turn without ending the conversation.
- No agent CLI installed means no chat anywhere, not a chat that errors.

## Next

- [x] `chat.rs`: `chat_available` / `chat_send` / `chat_cancel`, NDJSON →
      events, flags owned by Rust
- [x] `ChatPanel.tsx`: streaming bubbles, per-plan transcripts, seed path for
      "Flesh out", stop button
- [x] Settings: `chatCommand` binary; the old template demoted to the
      copyable command
- [x] Fake backend + `chat.spec.ts` covering send/stream/resume/cancel/absent
- [ ] Markdown rendering in bubbles, if plain text grates in real use
- [ ] Files-changed summary on `chat-done`, via a before/after `git_status`
