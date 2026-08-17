# Bugs

Open bugs, and the ones worth remembering after they were fixed. A bug earns a
line here when it was hard to see, when the cause was somewhere other than the
symptom, or when the same mistake could be made again.

Fixed entries stay because the pattern is the useful part. Each names how it was
found, since on this project the finding has usually been harder than the fix.

## Open

Nothing known. Add what you hit.

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
