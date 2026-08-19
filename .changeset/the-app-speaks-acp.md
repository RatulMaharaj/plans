---
"plans": minor
---

The chat speaks the Agent Client Protocol.

Instead of building one CLI's flags and parsing one CLI's output, the app is
now an ACP client: it starts an agent that speaks the protocol and draws what
that agent says. Which models exist, which reasoning levels, which slash
commands, whether a tool needs asking about — none of it is knowledge the app
holds any more. A second agent is a row in a table rather than a second parser.

Tool lines now carry the title the agent wrote for them, and finish: a call
goes from running to done in place instead of appending a second line.

Existing transcripts are kept as a record and the conversation starts fresh —
a Claude CLI session id means nothing to an ACP agent, and pretending
otherwise would be pretending to a continuity that is not there.
