---
"plans": patch
---

A message queued mid-turn is sent into the conversation it was typed in, not
whichever one is on screen when the turn ends — switching chats while a
message waited could send it to the wrong conversation, or lose it to a queue
that never drained. The in-flight guard is per conversation too, so a send in
one chat can no longer queue a message in another.
