---
status: done
---
# Agents That Outlive The Window

Closing the app kills every agent it started. That is not a bug to fix: an ACP
agent is a child on our stdin and stdout, so when the app goes the pipe goes.
Making an agent survive means it must not be our child — which means something
else has to own it, and that something is a daemon.

## What already survives, and what does not

Worth being exact, because most of the value is already there.

`claude-agent-acp` advertises `loadSession: true` (verified in the handshake),
and the app stores the session id and offers it back on the next prompt
(`session.rs`, the `LoadSessionRequest` branch). So after a crash or a quit the
*conversation* comes back: the agent kept it on its own disk, and reopening
reloads it.

What is lost is the turn that was in flight. An agent halfway through editing
three files stops, and nothing finishes it. That is the whole of the gap, and
it is worth sizing before building a daemon to close it: the question is not
"can we keep the conversation" — we can — but "do we need work to continue
while nobody is watching".

## What a daemon would be

A long-lived process that owns the agent processes and speaks to the app over
a socket. The app becomes a client of it, exactly as it is currently a client
of each agent.

- **Lifecycle.** Started on demand by the app, kept alive after the app exits,
  and shut down when? An agent that finished an hour ago should not still be
  resident. Idle timeout, or explicit stop.
- **Reattachment.** On launch the app asks the daemon what is running and
  re-subscribes to those sessions' updates. The transcript in localStorage and
  the daemon's view of the session have to be reconciled — the daemon will
  have seen turns the app did not.
- **Disagreement.** The app's transcript is the record and the daemon's is the
  truth. When they differ (the app was closed while three turns ran) the
  daemon wins, and the app has to be able to catch up rather than append
  blindly.
- **Permissions.** A permission request with nobody to ask is the hard case.
  Queue it and let the turn wait? Answer it from the agent's own mode and note
  that we did? Both are defensible; neither is obvious.
- **Supervision.** It is a background process on someone's machine: it needs
  a way to be seen, a way to be killed, and a story for what happens when it
  is a version older than the app that just launched.

## The honest costs

- A second thing to install, sign and notarize, or a second binary inside the
  bundle that is launched by path.
- A protocol between app and daemon, which is a third protocol in a codebase
  that just finished adopting its second.
- The failure modes are the worst kind: invisible, on someone else's machine,
  and about a process nobody remembers starting.

## Open questions

- Is the real need "work continues while the app is closed", or "the app
  reopens where it was"? Only the first needs a daemon.
- Could the agent's own background modes do this instead? Some CLIs can be
  told to run headless and report later; that would be their daemon rather
  than ours.
- Does tmux answer this? `plans/tmux-sessions.md` covered a version of this
  problem for terminal processes, and its argument — do not own a process you
  cannot supervise — applies here with more force.

## Done when

- Quitting the app leaves running agents running, and relaunching shows what
  they did while it was closed.
- Nothing is left running that nobody asked for, and there is a way to see and
  stop what is.

## Next

- [ ] Measure the gap first: how often does a turn actually outlive a session?
- [ ] Decide app-reopens-where-it-was vs work-continues-regardless
- [ ] If a daemon: choose the transport, and write the reconciliation rules
      before any code
