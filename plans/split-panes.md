---
status: done
---
# Split Panes

Plans shows one document at a time. Writing a plan means reading another one —
the bug it fixes, the plan it supersedes, the source file it describes — and
today that is a tab switch, a scroll back to where you were, and a switch back.
The app has tabs, a zen mode, and three views of the same buffer, all of which
are ways of arranging one thing.

The goal: two documents side by side, each with its own view, its own scroll
position, and its own cursor, moved between by keyboard.

We also need to make Ctrl + t, tab through the open buffers -  I didn't add a full plan for that but please do it.

## The real work is the state, not the layout

Two `<div>`s and a draggable divider is an afternoon. The reason this plan is
not an afternoon is that `App.tsx` has exactly one of everything a document
needs, held as component state:

```
activeRepoPath  activePath  content  matter  docKey  dirty
savedAt         source      epoch    conflict         stamp (ref)
pending (ref)   writing (ref)        view
```

Every one of those is per-document, and every one of them is currently a
singleton. `flush()` (`App.tsx:488`) writes `pending.current` against
`stamp.current`; `openFile` (`App.tsx:662`) replaces the whole cluster. Two
panes means two of each, and a save path that knows which one it is saving.

So the change is a refactor with a layout on the end of it:

- Extract the cluster into a `Pane` — the identity (`repo`, `path`), the buffer
  (`content`, `matter`, `docKey`, `source`), the save machinery (`stamp`,
  `pending`, `writing`, `dirty`, `savedAt`, `conflict`), and the `view`
- `panes: Pane[]` plus a `focused` index, replacing the singletons
- Everything currently reading `activePath` reads `panes[focused].path`

Do the extraction first, with one pane, and ship it. A single-pane app running
on the pane abstraction is a no-op the tests can prove; adding the second pane
after that is a small change rather than a rewrite with a new feature hidden
inside it.

## What stays global

Not everything should move into the pane, and getting this line wrong is what
makes split views feel like two applications glued together.

Per pane: the file, the buffer, the view, the scroll, the dirty and conflict
state.

Global: the tree, the git panel, the repos, the settings, the palette, the
toast, the status bar. `tabs` (`App.tsx:138`) is the interesting one — VS Code
gives each pane its own tab strip, which is honest but doubles the chrome. For
a two-pane editor a single strip that acts on the focused pane is less to look
at and loses nothing.

The file tree marks a file as open; with two panes it should say *where* it is
open, quietly — the mark system in `FileTree.tsx` already carries per-file
state and can carry this.

## Layout

Two panes, split vertically or horizontally, and no more. Recursive splits are
where editors grow a layout tree, a serialization format for it, and a set of
focus-movement rules nobody remembers; for a plans editor on a laptop screen
two is the number that is actually useful. Say no now, in writing, rather than
discovering the tree halfway in.

- `.page` becomes a flex container in `App.css`; each pane is the existing
  `.surface` / `.editor-host` stack unchanged
- A draggable divider, following the tree's resize handle (`App.tsx:1460`) —
  same `role="separator"` treatment, same persisted-width idea, so it behaves
  the way the one the app already has behaves
- Split ratio in `localStorage` next to `plans.tabs.v1` and friends
  (`App.tsx:29`), so the layout survives a restart
- Zen mode collapses to one pane. Zen is "one buffer and nothing else"; a split
  zen is a contradiction

The focused pane needs to be visible without being loud — a border treatment on
the inactive one, or a dimmed header. Two identical panes with an invisible
focus is how a keystroke ends up in the wrong document.

## Keys

The draft floats a vim/tmux leader (`ctrl+a`, or space). Don't. A leader key is
a modal state — press it and the next keystroke means something different —
and this is an app where the next keystroke is usually a letter someone is
typing into a document. `ctrl+a` is also "beginning of line" on macOS in every
text field, including this one's.

Follow the platform, and follow what the app already does. `App.tsx:1207`
onwards is already a flat `mod + key` table:

- `⌘\` split (the near-universal binding for it)
- `⌘⌥\` split the other way
- `⌘K ⌘\` cycle horizontal/vertical, if a cycle is wanted
- `⌘1` / `⌘2` focus pane one / pane two — but those are taken by the view
  switch (`App.tsx:1257`), so this needs deciding rather than assuming
- `⌘⌥→` / `⌘⌥←` move focus between panes — also taken, by tab cycling
- `⌘W` closes the pane when there are two, the buffer when there is one

The collision on `⌘1`–`⌘3` and `⌘⌥←/→` is the one genuinely contested piece of
this plan. Options: leave the view switch where it is and use `⌘⌥1/2` for
panes; or move the view switch to `⌘K 1/2/3` and give the digits to panes as
every other editor does. The second is more correct and breaks muscle memory
the app has already taught.

Whatever is chosen goes in the `blank-keys` list (`App.tsx:1608`) and gets
palette commands (`Palette.tsx`), because a binding nobody can find is a
binding nobody uses.

## Editors, twice over

Both surfaces stay mounted today and the hidden one is put aside with CSS,
deliberately — remounting Milkdown on every glance at the source is what made
switching feel slow (`App.tsx:1632`). Two panes means up to four mounted
editor instances: two Milkdown, two CodeMirror.

That is the main risk in this plan. Before building the layout, measure a
second Milkdown instance against the existing perf budgets (`src/perf.ts`,
`e2e/perf.spec.ts`) — memory, and whether typing in one pane costs anything in
the other. If it does, the fallback is to keep the mount-aside trick within a
pane but tear down the whole inactive pane, accepting a rebuild on focus
change.

The same file open in both panes is a case worth deciding early, not
discovering. Two Milkdown instances over one file, each with its own save
timer, both writing against `stamp.current`, is the conflict machinery firing
on the app's own edits. Simplest correct answer: focusing a file that is open
in the other pane moves focus there rather than opening a second copy.

## Saving

`flush()` becomes per-pane. The optimistic-concurrency check is already the
right shape for this — it compares a stamp taken when the file was read
against what is on disk — but `stamp`, `pending`, and `writing` are single
refs, so a save in one pane currently would use the other's stamp. They move
into the pane.

The autosave timer likewise: one per pane, not one shared. Blur-triggered
autosave (`autosave: "onBlur"`, `settings.ts`) gets a new meaning to settle —
window blur, or pane blur? Pane blur, probably: moving from one document to
another is exactly the moment a reader expects the first one to be written.

## Open questions

- The digit-key collision above — decide before any of it is built.
- Does the diff view work in a pane, or should it stay full width? A split diff
  (`diffStyle: "split"`) inside a half-width pane is four columns of text on
  half a screen.
- Should a pane be able to show a different repository? Nothing in the pane
  state prevents it, and it is useful — the plan in one repo, the code in
  another — but the tree and git panel are keyed to one active repo.
- Two panes with `watchSeconds` polling (`settings.ts`) is twice the polling.
  Probably fine at a 4-second default, worth checking at 1.
- Does zen mode remember the split it collapsed, and restore it on exit?

## Next

- [x] Ctrl+Tab through the open buffers — the one part of this plan that needed
      none of the refactor. `cycleTab` is now shared by ⌃Tab and ⌘⌥←/→ rather
      than written twice, and it reopens a memory buffer from what the app holds
      instead of trying to read a file that was never on disk
- [x] Built as composition rather than extraction: the second pane is a
      self-contained component (`SplitPane.tsx`) carrying its own buffer,
      stamp, pending write, autosave timer, watcher and conflict bar — the
      per-pane isolation the plan wanted, without holding the feature hostage
      to rewriting App.tsx's singletons. The full `Pane[]` extraction remains
      open as a refactor if a third reason for it appears
- [x] Per-pane `flush`, stamp, pending, and autosave timer — and pane blur
      (not window blur) is the split pane's "onBlur" save cue
- [x] The keymap, digit collision decided: ⌘\ split, ⌘⌥\ the other way,
      ⌘⌥1/⌘⌥2 focus panes — the bare digits stay the view switch. All in the
      new shortcut registry, so all rebindable
- [x] Two panes, flex layout, draggable divider (double-click evens out),
      ratio/direction/contents persisted in localStorage
- [x] Focus treatment (the idle pane's header dims), and focus-follows rather
      than second-copy for a file open twice — `openFile` routes by pane focus
- [x] Palette commands (Split, Split the other way, Close the split), hints
      from the registry
- [x] Drag to split: the tree's pointer drag recognises a drop zone along the
      page's far edge ("Open beside") and the open split pane itself, so a
      file can be pointed into a pane as well as keyed there — covered by
      `e2e/split.spec.ts`
- [x] Two sets of tabs after all — the plan's single-strip argument lost to
      use: the strip splits with the pane, each pane's chrome (tabs, path,
      badges) living inside it. The strips are disjoint sets: a tab dragged
      across *moves*, the next tab filling the space it left (or the blank
      state showing), and tabs reorder live within a strip. ⌃Tab cycles the
      focused pane's own strip
- [x] One view switch, in the chrome, acting on the focused pane; the split
      pane's own Write/Source buttons removed. Its header shows its file's
      status, owner and due, like the main header does
- [x] The split header carries a Frontmatter button and no close ✕ — the
      pane closes from the palette or with its last tab. "Swap the panes"
      trades the tab sets wholesale; "Open this document in both panes"
      deliberately duplicates one file, the watcher and conflict machinery
      mediating between the two views
- [x] Zen collapses to one; split state survives a restart and zen both
- [ ] The tree does not yet mark *where* a file is open — revisit with the
      mark system in `FileTree.tsx`
- [ ] A second Milkdown instance was not measured against the perf budgets
      first (the pane mounts two editors, as the main one does); if typing
      cost appears, the fallback stands — tear down the inactive pane
