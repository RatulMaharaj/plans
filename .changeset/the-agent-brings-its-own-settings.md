---
"plans": minor
---

The chat has a model picker, a reasoning-effort dropdown and slash commands —
none of which this app knows anything about. The agent advertises what it has
when the session opens, and the panel draws a dropdown per option in whatever
order they arrive; choosing one asks the agent and redraws from its reply,
because a choice can change what else is on offer.

Typing "/" completes from the commands the agent advertised, with arrows and
Tab. Completing is not sending — the agent parses the slash itself — and a
slash you meant literally still goes through.

Context used and what the turn cost appear under the input once the agent
reports them.
