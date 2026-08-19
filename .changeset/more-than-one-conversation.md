---
"plans": minor
---

A repository can have more than one conversation. The chat's header names the
current one — after the first thing you said in it — and picks between them;
**New** starts a fresh one and ends the agent's session with it, because a new
conversation the agent still remembers the last one from is new in name only.

`/clear` now does what it looks like it does. Sent on to the agent it cleared
the agent's context and left the transcript on screen, which was
indistinguishable from nothing happening; it is the same intent as New, so it
is the same action.
