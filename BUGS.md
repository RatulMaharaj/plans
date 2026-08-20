# Bugs

Open bugs, and the ones worth remembering after they were fixed. A bug earns a
line here when it was hard to see, when the cause was somewhere other than the
symptom, or when the same mistake could be made again.

Fixed entries stay because the pattern is the useful part. Each names how it was
found, since on this project the finding has usually been harder than the fix.

Remember to add changesets for any patched bugs - fixed bugs belong in the changelog rather than here.

## Open

- [ ] Command palette not showing chats across all repos - I like the bahivour of it changing dynamically based on focused repo, but we maybe need a toggle to make it do that or not - also maybe chats should persist across repos maybe that’s the magic of this? — the toggle is in; whether a *chat* should follow you between repositories rather than merely be findable is still open
- [ ] Dropping files from Finder into the window. Copying between open repositories now works by dragging, but a file from outside is a different problem: it needs Tauri’s own file-drop handling (`dragDropEnabled`), which takes away the HTML5 drag events the tree’s drag-to-move is built on. Planned in [`plans/drop-a-file-in.md`](plans/drop-a-file-in.md), and that trade is the decision it is waiting on.
- [ ] In the git tab, when pathnames are very long, the filename isn’t visible. Maybe we need a multiline setup with truncating.
- [ ] I need a way to refresh the list of branches
- [ ] I need to be able open a repo in my terminal easily. Right click open in
- [ ] Links between other markdown documents locally don’t seem to work
- [ ] No stop button in agent chat / or ability to hit esc to stop what it’s doing.
- [ ] We need to show a scrollbar for very long markdown documents, this needs to match our design / styling.  Scroll state needs to be preserved. Jumping between two docs shouldn’t reset the scroll position.

## Watch for

Not bugs yet — places the same class of mistake would land next.

- **Anything that renders into the document and caches.** The mermaid bug below
  was a cached picture outliving the thing it was drawn from. The HTML view has
  a picture cache (`html-view.ts`) keyed by repo and path; if an image is
  replaced on disk under the same name it will serve the old bytes.
- **Anything that compares a fingerprint.** `stat_plan` answering `"absent"` for
  a missing file was treated as a stamp like any other, which is how a renamed
  file became a conflict. Any future "has this changed" check needs to say what
  it means by *gone*.
- **Anything that works in a test but not in the app.** Three separate causes so
  far: the Tauri window swallowing drag events, WKWebView delivering a pasted
  image through `items` rather than `files`, and Milkdown dropping `<br/>`. A
  green test proves the harness agrees with the code, not that the app works.

## Fixed

### A file grew an empty frontmatter block in front of its real one

`agents-flesh-out-plans.md` was found starting `---`, blank, `---`, then `---`,
`status: draft`, `---`. Only the first block parses as frontmatter, so the
status was invisible to the app while the source looked almost right.

`null` and `""` are not the same answer. `null` means the file has no
frontmatter; `""` means the block is there and holds nothing — which is exactly
what emptying the sheet’s textarea hands back. The join treated only the first
as "write nothing", so the second wrote a bare pair of fences ahead of whatever
was already there.

Found by reading the file, not by using the app, which was the part worth
fixing: nothing surfaced it. The repair is now in the join itself, ahead of the
write-it-back-verbatim path, so a file already carrying an empty block is fixed
by saving it.

### Only the active file was checked for outside edits

A plan open in another tab that an agent or a `git checkout` rewrote stayed
unremarked until it was clicked back to.

The stamp poll stat’d `activePath` and nothing else. A background tab holds no
text — switching to one re-reads from disk — so there was never anything to
reload or to lose; what was missing was the telling. Every open buffer is now
checked, on the slow tick rather than the watch interval, for the same reason
the tree walk is staggered, and a changed one is marked in the tab row.

### Reload did not let go of deleted folders

A folder removed outside the app — by hand, by an agent, or by a git checkout —
stayed in the sidebar, and reloading did not clear it.

Empty folders exist only in localStorage: git does not record them and the file
walk cannot see them, so the app remembers them itself. That memory had one
eviction rule — a folder leaves the list when it gains markdown — and none for
the folder itself disappearing. Nothing on disk was ever asked.

Now every file refresh (the poll and Reload both go through it) also asks the
disk which remembered folders still exist, and drops the rest. Any purely
local cache of something on disk needs an answer for *deleted underneath us*,
not only for *superseded*.

### Chrome text was selectable

Dragging across buttons, header tabs, the rail or the status bar started a text
selection, so the app's furniture highlighted like prose. One rule now turns
selection off for buttons and the chrome regions; the document and the inputs
keep theirs.

### Clicking a file showed the previous one

Some files would not open at all — a blank buffer, or the document you were
already looking at, unchanged.

A `<br>` was being turned into a line break wherever it appeared, including one
standing on its own between blocks. mdast puts that at the root of the document,
and a break at the root builds a document ProseMirror refuses:
`Cannot create node for doc`. The whole file failed, not the block, and because
the swap threw, the previous document stayed on screen.

The conversion is now limited to the places a break can legally go — inside a
paragraph, heading, link, table cell — and a block-level `<br>` keeps its html
node, which renders anyway.

Found from the trace log: every failing swap named the offending content, with
`hardbreak` sitting between a heading and a paragraph. Not reproducible in the
test harness until the fixture used a standalone `<br />`, which is exactly how
these files are written.

### Diagrams kept their colours when the paper changed

A mermaid diagram stayed in the old theme's colours until the file was closed
and opened again.

The diagram's colours are baked into its SVG when it is drawn, so a change of
paper has to redraw it — and it did rebuild the decoration set. But the widget
was keyed by position and source only, and ProseMirror deliberately *reuses* a
widget whose key has not changed. The rebuild produced the same keys, so every
diagram was reused untouched.

The key now includes the paper, and the render cache is keyed by paper too
rather than relying on being cleared: an SVG drawn for one paper is not an
answer for another. Found by being told; the cause was found by reading what the
key was for.

### Frontmatter grew a line on every save

With the frontmatter panel turned off — which puts the YAML back in the document
— saving rewrote the closing `---` as `----------------` and added another rule
each time.

The parser had no idea what frontmatter was: it read the fence as a thematic
break and the YAML as a setext heading underneath it. Fixed with
`remark-frontmatter` plus a schema for the `yaml` node it produces; without the
schema the editor did not merely mishandle the block, it refused to start, since
an unknown node type fails the whole document.

Found by the round-trip fixture the formatters plan asks for, which was written
to answer a different question entirely.

### A renamed file could not be edited

After renaming, every save was refused and a conflict appeared against nothing.

`stat_plan` returns `"absent"` for a file that is not there, which compares as a
perfectly good stamp — so *gone* and *changed* were indistinguishable. A clean
buffer tried to reload a path that no longer existed; a dirty one raised a
conflict, and from then on nothing could be written.

Now an absent file is ignored by the watcher, and a stale write against a file
that has vanished is simply written: nothing can be overwritten, and the buffer
is the last copy of the text.

### Drag and drop did nothing in the app

Every test passed in a browser. Tauri's window takes drag events for native file
drops before the page can see them — `dragDropEnabled: false` is required, and
its own documentation says so.

### Switching files crashed the window

A plugin dispatched a transaction from its own `update` hook, which re-entered
the update cycle and recursed until the stack gave out. The guard meant to make
it rare was only ever set when a diagram rendered, so a file with no diagrams
recursed immediately.

Never dispatch from `update`; watch the thing that changed instead.

### Typing was unusable

Four causes, none of them the algorithm:

- The dev watcher restarted the whole app on every autosave, because the file
  being edited lived under `src-tauri/`. See `.taurignore`.
- The hidden source view reparsed the entire document on every keystroke.
- Both ProseMirror plugins rebuilt their decorations rather than mapping them.
- Every open repository was walked, with a `git check-ignore` subprocess, every
  four seconds.

Found with the profiler (`⌘⌃P`), which is in the app for exactly this. `render
App` measured 0ms while the window was unusable, which is what pointed away from
React and towards the polling.

### Opening a file wrote it back

Parsing markdown and serialising it is not the identity — bullets, escaping,
HTML. Those serialisations arrive through the same channel as typing, so merely
opening a file marked it dirty and autosave wrote the rewrite to disk.

Nothing counts as an edit now until a person types, pastes, cuts, drops, or uses
the HTML editor.
