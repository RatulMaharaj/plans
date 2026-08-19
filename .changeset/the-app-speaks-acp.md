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

The chat starts fresh. Earlier transcripts are left on disk but not shown: a
Claude CLI session id means nothing to an ACP agent, so a conversation carried
across would be a conversation only on one side.
