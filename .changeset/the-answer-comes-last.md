---
"plans": patch
---

Two chat fixes. The transcript keeps the order things happened in: streamed
text grows its bubble only while that bubble is still the last message, so
an answer written after tool calls lands *below* them instead of being glued
onto earlier prose above — the closing answer is now always the last thing
on screen. And Stop moved out of the header, where long chat titles ran into
it, to float just above the composer: the answer is stopped where the next
message is typed, which Esc already did.
