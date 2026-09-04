---
status: done
---
# The app is the agent's filesystem in a workspace

> Wait what - can't we just fake it for the agent? Or let the agent make
> updates in the database via a tool

## Problem

An agent runs in a working directory, and a workspace file has none: the
chat in a workspace was starting the agent with the memory buffer's
placeholder as its directory, and now does not start at all. The mirror plan
(`workspace-mirror.md`) answers this with git, which is right for the
factory but a long way round for a conversation about the file on screen.

## Approach

The protocol already routes an agent's file reads and writes through the
client when the client says it can: the app advertises those capabilities
today. So the app can be the workspace's filesystem, with a scratch folder
for the parts of an agent that want a real path.

- **A scratch checkout per workspace.** Opening the chat in a workspace
  writes the room's tree into a folder under the app's cache directory,
  keyed by workspace id, and starts the agent with that folder as its
  working directory. Listing, grepping and shell tools work, because the
  files are really there.
- **Reads answer from the room, writes go to it.** The client-side handlers
  for `fs/read_text_file` and `fs/write_text_file` — today they touch disk —
  learn the scratch folder: a read inside it answers with the room's current
  text, and a write inside it becomes an edit to the room's document, then
  a refreshed file. The room stays the truth; the folder is a cache the
  agent is allowed to believe in.
- **An edit to a file nobody has open** needs markdown turned into a
  document edit, which is what the write editor does for an open file. The
  app mounts a hidden editor bound to that file's room for as long as an
  agent is writing to it, and lets it go afterwards. Same machinery, no
  surface.
- **The folder follows the room.** A change from anyone lands in the folder
  on the same debounce that publishes `meta.markdown`, so the agent's next
  read is current. New files and renames in the tree are files and renames
  in the folder.
- **Status is just a write.** An agent setting `status: done` in a file's
  frontmatter is an edit like any other; the tree's dot follows.

## Implementation guide

- [x] `src-tauri/src/agent/client.rs` - the read and write handlers check
      whether the path is under a registered scratch folder, and if so ask
      the frontend (an event with a reply) rather than the disk
- [x] `src-tauri/src/agent/mod.rs` - `agent_prompt` accepts a scratch
      folder to start in; a command materialises and refreshes the folder
      from text the frontend hands it
- [x] `src/workspace.ts` - a `scratch(id)` that writes the tree to the
      folder and keeps it current while a chat is open
- [x] `src/App.tsx` - the chat is offered in a workspace again, against the
      scratch folder; writes arriving from the agent go to the open editor,
      or to a hidden one mounted for the purpose
- [x] `src/Editor.tsx` - a headless mode: bound to a room, no host in the
      layout, one `replace` and gone
- [x] `e2e/workspace.spec.ts` - an agent's write to a workspace file
      appears in the other person's editor; a read answers with what they
      typed a moment ago

### What landed, and where it differs from the guide

- The app did not advertise the `fs` capability before this; the session
  only offered form elicitation, so there were no read and write handlers to
  teach. `session.rs` now advertises `fs.readTextFile` and
  `fs.writeTextFile`, and `client.rs` gained both handlers: the disk for a
  repository, the frontend (an `agent-fs` event answered by
  `agent_fs_reply`) for a path under a registered scratch folder. Outstanding
  reads and writes are refused when a session stops or a turn is cancelled,
  the way permissions are.
- `agent_prompt` did not change. Its `repo` was always the working
  directory, so the chat in a workspace hands it the folder that
  `workspace_scratch` answered with, and that folder is also the key the
  workspace's conversations are stored under. The new commands are
  `workspace_scratch(id, files)` and `workspace_scratch_forget(id)`, in
  `src-tauri/src/agent/scratch.rs`.
- The folder is written whole on every change, from every file's room. That
  means the app opens a room for each file in the workspace while a chat is
  wanted there, including files nobody has on screen; the cost is one
  socket per file, which is fine at the sizes workspaces are today.
- A write from the agent replaces the whole document (`replaceAll`), as the
  Source view does. The open question about diffing against the room's text
  to keep other people's cursors in place is still open.

## Out of scope

The factory. It dispatches from git, and needs the mirror. Two agents in
one workspace at once, which the scratch folder per workspace would have to
become a folder per chat to support.

## Open questions

- Does the adapter route *every* read through the client, or only the
  agent's own Read tool? A shell `cat` reads the folder, which is a cache —
  fresh on the debounce, but not the room itself.
- A write that arrives while someone is mid-word in the same paragraph:
  Yjs merges, but the agent's whole-document write is a large edit. Diffing
  the agent's text against the room's and applying only the change would
  keep other cursors where they are.
