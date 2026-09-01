---
"plans": patch
---

A message sent while the agent is mid-turn is queued and sent when the turn
finishes, in order. It used to be dropped silently: the composer had already
cleared the box by the time the busy guard fired, so what you typed was gone.
The transcript says "queued" when this happens, and if the session dies before
the queue drains, it says the queued messages went with it.
