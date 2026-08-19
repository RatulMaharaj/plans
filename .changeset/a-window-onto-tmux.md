---
"plans": minor
---

Plans can talk to a coding agent about the open plan.

⌘J opens a conversation under the document. Ask for anything — the answer
streams in, and edits the agent makes land in the files where the watcher,
the tree marks, and git already show them. Each plan keeps its own
transcript, resumed (context and all) when the plan is reopened.

"Flesh out this plan" is the first message of that conversation. The agent
is whichever CLI you name in settings (`claude` by default); the app runs it
headlessly one turn at a time, never in the background, and never commits.

Machines without the agent CLI see none of it rather than a chat that fails.
