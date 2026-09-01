# Bugs

Open bugs, and the ones worth remembering after they were fixed. A bug earns a
line here when it was hard to see, when the cause was somewhere other than the
symptom, or when the same mistake could be made again.

Fixed entries stay because the pattern is the useful part. Each names how it was
found, since on this project the finding jhas usually been harder than the fix.

Remember to add changesets for any patched bugs - fixed bugs belong in the changelog rather than here.

## Open

(nothing at the moment)

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

### All-files mode still hid empty folders

The tree is built from the file walk's results, so a folder holding nothing -
or holding only what the walk skips - had no way into it; the only empty
folders shown were the ones created in the app, remembered in localStorage.
All-files mode now asks the disk for the directories too, with the same
ignore and skip rules, and merges them into the tree. Same family as the
deleted-folders bug below: a tree derived from files answers questions about
files, and every question about folders needs its own source.

### A message sent while the agent worked vanished

The busy guard in send() returned silently, and Enter had already cleared the
box before the guard ran, so what was typed was simply gone - worst at the end
of a turn, when the composer looks idle but the turn has not ended. The guard
now queues the message and the turn-ended listener sends it. The pattern: any
guard that refuses input after the UI has taken it must put the input
somewhere, because "refused" and "lost" look identical to the person typing.

### A dropdown opened inside a sheet was clipped by it

`.matter-sheet` has `overflow: hidden` for its rounded corners, and the menu
rendered inside it as an absolutely-positioned child. The menu now goes
through a portal to the body at the trigger's measured viewport position.
Found by reading the sheet's CSS rather than the dropdown's: the symptom
named the wrong component. A portalled menu loses its descendant CSS
selectors, so a no-layout twin of the wrapper (`display: contents`) carries
the class names in with it.

### A stray paste split a selector in two

The `.chat-pick` block had been pasted a second time into the middle of
`.chat-tool .chat-where` - the selector's two halves sat either side of ten
duplicated lines, quietly styling `.chat-tool .chat-pick`, which matches
nothing. Nothing failed loudly; one rule vanished and a duplicate shadowed
later edits to the original. Found while fixing the title overflow next door.

### Stop was read only after the turn it was stopping

The session loop handled one op at a time, and a running prompt *was* the
current op — `Op::Cancel` sat unread in the channel until the turn finished on
its own, the one moment it no longer meant anything. And even read, it only
answered pending permissions; nothing ever told the agent to stop. The loop
now `select!`s the channel against the in-flight prompt and sends a real
`session/cancel`. Found by tracing the press to the backend and asking what
consumes the queue while the thing being cancelled is still running: any
"stop" delivered through the same single-consumer channel as the work is a
stop that waits for the work.

### The palette's skill commands assumed one agent's path

"Open the … skill" opened `.claude/skills/<name>/SKILL.md` — one of several
places installing writes, and possibly none of them. A repository whose
conventions live in a fenced `AGENTS.md` section had a command that errored
against a path that never existed. The path is resolved at press time by
walking the same targets installing would. The pattern: a command built from
a constant answers for the machine it was written on, not the one it runs on.

### The maximised diagram cropped what it existed to show

`fit()` scaled the SVG to the frame's *width*; a tall diagram overflowed the
frame's height, flex centred it, and the top and bottom were clipped — with
pan disabled at 1:1 because the clamp thinks an unzoomed picture has nowhere
to go. The full view now contains on both axes, so it opens whole, and a
plain wheel zooms there (a modal has no document behind it for the scroll to
have meant). Same family as the figure clipping: any box that centres content
it also clips has decided some of the content is unreachable.

### Write and Source each kept their own scroll

The per-buffer scroll memory watched `.editor-host`, which is the Write and
Diff surface — Source scrolls CodeMirror's own `.cm-scroller`, so a mode
switch landed at wherever that element happened to be. The memory now follows
the visible surface and carries the position across modes as a fraction of
the scrollable range, since the same text lays out at different heights. The
cross-mode restore waits for the height to stop moving first: a fraction of a
range still growing lands short.

### The answer was never the last thing in the chat

Streamed text appended to "the message of this role in the current turn" —
a backwards scan past everything since the last user message — so an agent
that wrote prose, ran tools, and then wrote its real answer had that answer
glued onto the prose *above* the tool lines. The transcript ended in tools;
the answer hid mid-scroll, which also read as "cut off".

Streaming now grows a bubble only while it is still the last message;
anything after a tool line starts a new one. Prose, tools, prose is three
sections in the order they happened. The test that pinned the old behaviour
was asserting the bug and was rewritten to assert the order.

### The chat title ran into Stop

Both lived in the header, one truncating toward the other. Stop now floats
just above the composer — the answer is stopped where the next message is
typed, which Esc in the box already did — and the header keeps only the
title and the chat actions.

### Dropping a file from Finder did nothing

The trade `drop-a-file-in.md` was waiting on is decided: `dragDropEnabled` is
on, so dropped files arrive with real paths and open editable, saving back to
where they came from. The tree's drag-to-move — built on the HTML5 drag events
that setting takes away — was rebuilt on pointer events: a press, a movement
threshold, `elementFromPoint` to find the folder under the pointer, a drop on
release. Pointer events sit below the native drag machinery, so nothing can
swallow them. Worth a manual check in the built app; Playwright sees neither.

### Long paths hid the filename in the git panel

`.change-dir` had `flex-shrink: 0`, so a deep folder path pushed the one part
of the row that mattered — the filename — out of view. Inverted: the name
never shrinks, the folder path truncates from the front so the nearest folder
survives. Found by reading the CSS after the report; the symptom named the
wrong element.

### No way back to a fresh branch list

Branches are fetched on demand (they cost seconds on a big repository) and
cached until the epoch moves. "Refresh branches" in the git commands now
re-reads the list when the cache is the thing you are fighting.

### Links between documents did nothing

No handler existed: a click in the editor was only ever an editing click.
⌘-click now follows a link — a relative path resolves against the open file's
folder and opens in the app; a scheme goes to the system browser — and plain
clicks are prevented from ever navigating the webview away from the app.

### Escape did not stop the agent

The Stop button existed; the keyboard gesture every terminal agent teaches
did not. Escape in the composer now cancels the running turn when one is
running, and leaves the box when none is. ("Open in Terminal" on a
repository's right-click menu landed in the same pass.)

### Scroll position was shared, then lost

Every open rebuilt the editor at the top, so jumping between two documents
reset both. The position is remembered per `repo::path` and restored after
the rebuild — retried for a few frames, because setting `scrollTop` on a
Milkdown host that has not finished building clamps to zero. The document
also shows a thin scrollbar again (the app hides them globally); a long plan
with no bar gave no sense of place.

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
