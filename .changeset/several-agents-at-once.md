---
"plans": minor
---

Two agents can work at the same time, and moving between conversations no
longer kills one.

A session was keyed by repository, so there was one by construction. Changing
chat meant changing which conversation that single session was having — which it
cannot — so it was ended instead. Setting an agent going on a long job and
reading another conversation while it worked was not something you could do.

A session is now keyed by the conversation it is having. What ends one is
deleting the chat, clearing it, or quitting; navigating does not. Every event
the agent produces names its conversation, so an answer arriving for a chat you
are not looking at lands in that chat's transcript rather than being dropped —
which is what used to happen, permanently, including after switching back.

Everything that was one-per-repository followed:

- The turn in flight is per conversation, so a long job in one does not disable
  the composer in another, and Stop belongs to the chat it is in.
- Permission requests are asked and answered per conversation. Their ids now
  carry the chat, because a tool call id is only unique within its own session
  and two sessions in one repository could mint the same one — answering in one
  chat could have resolved the other's question.
- Context and cost are read per conversation. Two sessions were overwriting each
  other's reading, so the status bar showed whichever spoke last under a label
  saying it was the repository's.
- The conversation picker puts running chats first, under their own rule, and
  the rail carries a count of how many agents are working — across every
  repository, since what that number is about is processes on the machine.
