---
status: done
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

## What a spec pass turned up

Specifying this properly found six things the plan does not mention, each of
which breaks the moment the four `agentStop` calls are removed. They are
recorded here because they are the actual work, and none of them is visible
from the plan as written:

- **Narration is routed through a single `turn` ref** (`ChatPanel.tsx`), and
  the key effect nulls it on every chat switch. Stop killing the session on
  switch and every message, thought, tool line and turn-end for the chat you
  left is discarded permanently — including after switching back. Routing has
  to move onto the chat id before anything else in this plan is safe.
- **`/clear` becomes a process leak.** It routes to `onNewChat`, whose comment
  says the session ends with it. Once that is no longer true, four characters
  start a fresh chat and leave a `node` behind that nothing can reach or stop.
- **Permission request ids are `repo::toolCallId`.** Two sessions in one repo
  can mint the same tool call id, so an answer can resolve the wrong chat's
  request — unreliable exactly when two agents run.
- **`agent-usage` carries only a repo**, and the state is keyed by repo, so two
  live sessions overwrite each other's reading and the status bar shows
  whichever spoke last, mislabelled. That is a bug regardless of which usage
  the bar is meant to show.
- **Per-chat `busy` is not just the flag.** The send guard and the single Stop
  button are both bound to the one turn in flight, so a turn running in one
  chat still blocks the composer in another.
- **`agent-down` had no way to say which session it was about.** Fixed already
  — see Next — because it was a bug before this plan.

## The decisions, and what they were

Recorded because they were the argument, not because they were hard:

- **Deleting a chat stops its agent.** Forgetting a transcript while its process
  keeps running leaves an agent nobody can reach, read or stop, which is the one
  thing this app promises not to leave behind. The plan's worry about an agent
  killed halfway is about *closing*, and closing is not something a chat has.
- **`/clear` stops the session it clears**, which is only what it already did —
  it routes to New chat, and New chat used to end things. The stop is explicit
  now rather than a side effect of how sessions were keyed.
- **Stop belongs to the chat it is in.** This plan said so already.
- **Usage is the focused chat's.** Not really a choice: keyed by repository, two
  sessions overwrote each other, so the bar was showing whichever spoke last
  under a label that said otherwise. That was a bug either way.
- **No ceiling, for now.** The plan asked for "a ceiling, or at least a count
  that is visible". The count is visible. A limit needs a number, and there is
  no evidence yet for what it is.

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

- [x] A generation number per session, carried on `agent-ready` and on
      `agent-down`. Not part of the rekeying, but the same question asked
      earlier: the two `agent-down` emits for one stop were indistinguishable,
      so a stopped session's farewell cleared a *running* session's turn and
      its answer went nowhere. Fixed and tested ahead of the rest, because it
      is a bug today rather than only under two agents
- [x] Per-session turn state, replacing the `CURRENT_TURN` global
- [x] `(repo, chat)` keying through the commands and the events
- [x] Per-chat `busy`, and a visible count of what is running
- [x] Active/archived grouping in the picker and in `#`
- [x] The five things the spec pass turned up above: narration routed on the
      chat rather than on a single turn ref, `/clear` stopping the session it
      clears, chat-unique permission ids, usage keyed per conversation, and the
      send guard and Stop button belonging to the chat they are in

Left for when there is evidence it is wanted:

- [ ] A ceiling on how many agents may run at once. The count is visible, which
      is what this plan asked for; a limit needs a number, and a number without
      a real machine slowing down is a guess.
- [ ] A "waiting" mark for a permission request in a chat you are not looking
      at. The request now waits in its own transcript rather than being lost,
      so this is a way of noticing sooner rather than a way of not losing it.
