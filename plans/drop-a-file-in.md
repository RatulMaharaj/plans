---
status: done
---
# Drop A Markdown File In And Edit It

Dragging a `.md` file from Finder onto the window should open it and let you
write in it. Today nothing happens: the app can only open what is inside a
repository it has been told about, so a file on the desktop is unreachable
without adding its whole folder.

## The one setting this turns on, and what it costs

`tauri.conf.json:22` sets `"dragDropEnabled": false`. That is deliberate, not
an oversight — with Tauri's own file-drop handling on, the webview stops
seeing HTML5 drag events, and the tree's drag-to-move (`FileTree.tsx:313` and
the ref-held dragover around `:245`) is built on exactly those.

So this is the first question to answer, before anything else:

- Turning it on gives real filesystem paths for dropped files, and takes away
  the tree's internal drag unless it is rebuilt on Tauri's events.
- Leaving it off keeps the tree working, and a dropped file arrives as a
  `File` object with **no path** — readable, but not writable back, which
  makes "edit in place" impossible.

There is no clever third option. Editing in place needs a path, so this needs
the setting on and the tree's drag reworked, or it needs to not be "in place".

## A buffer with no repository

The app is built on repo-relative paths — `safe_join` (`lib.rs:15`) refuses an
absolute one outright, and every command takes `(repo, relPath)`. A dropped
file may be anywhere.

The shape already exists. `MEMORY` (`App.tsx:95`) is a sentinel repo for
buffers that are not files, and `activeRepoOrPath` handles a buffer whose repo
is not in the list. A dropped file is the same idea one step further: its
"repo" is its containing directory, and its `relPath` is its filename. Nothing
in `safe_join` has to change — the join is still inside the root it was given.

What that quietly gets right: the watcher, autosave and the stamp-based
conflict check all work, because they only ever needed a directory and a name.

## No diff, and the reason generalises

Diff compares against the last commit. A file dropped from the desktop has no
repository, so there is nothing to compare to — the Diff tab would be an error
message with a tab of its own.

The rule worth writing down is broader than this feature: **the view switch
should offer what the buffer can actually do.** Memory buffers already hide it
entirely. A dropped file shows Write and Source, and no Diff. A dropped file
that happens to be inside a repo the app already knows should just open as that
repo's file, and keep Diff.

## Open questions

- Is a dropped file added to the tree, or does it live only in its tab? A tab
  only is simpler and matches the release-notes buffer; but then reopening the
  app loses it, and a path in `localStorage` would restore it cheaply.
- Non-markdown dropped files: refuse, or open in Source read-only? See
  `see-every-file.md` — the same rule about the writing surface applies.
- Dropping a *folder* is the existing "add a repository" gesture. Both on one
  drop target needs the two cases told apart clearly.

## Done when

- A `.md` dropped on the window opens in the editor and saves back to where it
  came from.
- Its tab shows Write and Source, and no Diff.
- Dropping a file that lives in an open repository opens it as that repo's
  file, diff and all.
- The tree can still be dragged, or its drag has been rebuilt on whatever
  events remain.

## Next

- [x] The half that needs none of this: a file can be dragged from one open
      repository into another, which is a copy rather than a move. `copy_plan`
      takes two `(repo, relPath)` pairs and joins each inside its own root, so
      widening to two repositories widened nothing else
- [x] Decided: `dragDropEnabled` is on. The HTML5-vs-native conflict the plan
      feared is Tauri's documented *Windows* limitation; on macOS the
      webview's internal drag (the tree's move) and Tauri's native file-drop
      events coexist. Worth one manual check in the built app: drag a file
      inside the tree, then drag one in from Finder — Playwright runs against
      the browser and cannot see either
- [x] A dropped file as `(dir, name)` — its folder is the root every command
      already takes, so watcher, autosave and the stamp check just work. It
      lives in its tab (which `plans.tabs.v1` already restores across
      restarts); in-repo drops open as the repo's own file
- [x] Views offered per buffer: a dropped file shows Write and Source, no
      Diff — the button is absent and `goto("diff")` declines, same as memory
      buffers hide the whole switch
- [x] A dropped folder is the add-a-repository gesture; non-markdown is
      declined with a toast
