---
"looped-plans": minor
---

The agent chat is back in a workspace. Each workspace gets a scratch folder
under the app's cache directory, written from the shared documents and kept
current as people type, and the agent is started there. Its reads and writes
under that folder are answered by the app from the shared document rather
than the disk: a read is what was typed a moment ago, and a write lands in
everyone's editor - through the one on screen, or through an editor nobody
sees for a file nobody has open. A file the agent writes that the workspace
does not have yet is created in the tree, folders and all.
