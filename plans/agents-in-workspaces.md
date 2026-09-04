---
status: ready
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

- [ ] `src-tauri/src/agent/client.rs` - the read and write handlers check
      whether the path is under a registered scratch folder, and if so ask
      the frontend (an event with a reply) rather than the disk
- [ ] `src-tauri/src/agent/mod.rs` - `agent_prompt` accepts a scratch
      folder to start in; a command materialises and refreshes the folder
      from text the frontend hands it
- [ ] `src/workspace.ts` - a `scratch(id)` that writes the tree to the
      folder and keeps it current while a chat is open
- [ ] `src/App.tsx` - the chat is offered in a workspace again, against the
      scratch folder; writes arriving from the agent go to the open editor,
      or to a hidden one mounted for the purpose
- [ ] `src/Editor.tsx` - a headless mode: bound to a room, no host in the
      layout, one `replace` and gone
- [ ] `e2e/workspace.spec.ts` - an agent's write to a workspace file
      appears in the other person's editor; a read answers with what they
      typed a moment ago

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
