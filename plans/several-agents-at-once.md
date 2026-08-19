---
status: ready
---
# Several Agents At Once, And A Shelf For Finished Ones

Two agents cannot run at the same time, and switching chats kills the one that
was running. Both come from the same decision: a session is keyed by
repository (`agent/mod.rs`, `Agents(Mutex<HashMap<String, Live>>)`), so there
is one per repo by construction and changing chat means changing which
conversation that single session is having — which it cannot, so it is ended.

The workflow this blocks is the ordinary one: set an agent going on a long
job, start a second while it works, and move between them.

## Key the session by chat, not by repo

The change is small to describe and touches every layer.

- **Rust.** `Agents` becomes keyed by `(repo, chat)`. `agent_prompt`,
  `agent_cancel`, `agent_set_config`, `agent_permission` and `agent_stop` all
  take a chat id. `CURRENT_TURN` — a single global that stamps notifications
  with the turn most recently sent — stops working the moment two sessions run
  at once, and must become per-session state carried into the notification
  closure.
- **Events.** Every `agent-*` payload gains the chat id beside the repo. The
  panel currently routes on turn id and repo; it will route on chat.
- **The panel.** Switching chats stops calling `agentStop`. `New` stops
  killing anything. What ends a session is closing the chat, or quitting.
- **Concurrency.** `busy` becomes per chat, so a turn running in one does not
  disable the composer in another. The stop button belongs to the chat it is
  in.

## Active and archived

Falls out of the above rather than being built on top: a chat is **active**
while it has a live session and **archived** when it does not. Nothing is
decided by a timer — the state is a fact about a process, not a policy.

- The picker and `#` in the palette split into two groups, active first.
- An archived chat opens read-only-ish: it shows its transcript, and speaking
  in it starts a session again (resuming, via the stored session id) which
  makes it active. There is no separate "unarchive".
- A running agent should be visible without opening its chat — a count on the
  rail button, or a dot beside the active ones in the picker. The rail button
  already carries a `count` badge for git; the same idea.

## What this costs

- **Several agent processes at once**, each a `node`. Two is fine; a dozen is
  a machine slowed to a crawl by a UI that never said so. A ceiling, or at
  least a count that is visible.
- **Cost, multiplied.** The status bar reads one session's usage; with several
  it should read the active repo's total, or the focused chat's, and be clear
  which.
- **Permission requests from a chat you are not looking at.** They cannot
  block silently. Probably: the picker marks the chat as waiting, the same way
  the tree marks a changed file.

## Open questions

- Is the unit a chat, or a plan? A chat is what exists now, but "run the agent
  on this plan while I read another" suggests the plan. The chat is per repo
  and mentions the plan, so chat is the safer unit and the one already keyed.
- Should closing a chat's tab stop its agent? Closing is not the same as
  finishing, and an agent killed halfway is worse than one left running.
- How many is too many, and what happens at the limit — refuse, queue, or
  warn?

## Done when

- Two chats can be mid-answer at the same time, and switching between them
  shows each one's progress without interrupting either.
- The picker shows which are running and which are finished, separately.
- Quitting still leaves nothing behind (see `agents-in-the-background.md` for
  the other half of that question).

## Next

- [ ] Per-session turn state, replacing the `CURRENT_TURN` global
- [ ] `(repo, chat)` keying through the commands and the events
- [ ] Per-chat `busy`, and a visible count of what is running
- [ ] Active/archived grouping in the picker and in `#`
