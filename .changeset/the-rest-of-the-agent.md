---
"plans": minor
---

The agent's task list appears above the transcript while it works, amended in
place as it goes. A session survives the process: if the agent dies between
turns, the next thing you say asks it to pick the conversation back up rather
than starting over.

Answers render as markdown — bold, code, fences and lists — by building
elements rather than injecting markup, so an agent quoting HTML from a file
shows you the HTML instead of running it. What you typed is still shown exactly
as you typed it.

Codex, Gemini and OpenCode are in the agent list alongside Claude Code. They
were never a second integration; they are rows in a table.
