---
"plans": patch
---

Fixes a running agent going silent after another session was stopped.

`agent-down` is emitted twice for one stop, and has to be: the session is told
to go and says so at once, so the panel is not left waiting on a process that is
already unreachable, and the session's own task says so again when it has
actually finished — which is arbitrarily later, because telling a session to
stop only queues the message.

With nothing to tell the two apart, that second farewell was indistinguishable
from news about whatever was running by then. Stop a session, start another, and
the first one's goodbye cleared the second one's turn — after which the live
agent's answer went nowhere, which looks exactly like an agent that has nothing
to say. Every session now carries a number, and a message about a session older
than the one in hand is a message about something already over.

Found while specifying `plans/several-agents-at-once.md`: the refactor needs
events to say which session they belong to, and asking that question turned up a
case where the answer already mattered.
