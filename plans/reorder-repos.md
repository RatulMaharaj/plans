---
status: busy
---
# Reorder repos

Drag a repository heading up or down the sidebar and the tree follows. The
feature is small because the hard questions are already answered elsewhere in
this app; the work is mostly in not breaking the two drag systems the sidebar
already hosts.

## The order already exists — it just can't be changed

There is no sort applied to repositories anywhere: the tree renders
`p.repos.map(...)` in array order (src/FileTree.tsx:842), the boot sequence
restores them in the order their paths were saved (src/App.tsx:807–816), the
persistence effect writes `repos.map((r) => r.path)` straight back
(src/App.tsx:868), and every way in appends — the add dialog
(src/App.tsx:1197) and the CLI open (src/App.tsx:831) both do
`[...prev, info]`. So the order is insertion order, remembered faithfully
forever, with no way to say otherwise.

That makes the state side of this feature one function: permute the `repos`
array. Persistence is free — the existing effect saves whatever order the
state holds. The rename-alias overlay is keyed by path (src/App.tsx:229–237)
and never cares about position. Nothing else in the app reads repo order at
all; `activeRepoPath` is a path, not an index.

## Drag, on the machinery that is already there

Pointer events, not HTML5 drag-and-drop — this is settled law in this file.
`dragDropEnabled` is on so Finder drops arrive with real paths, and with it on
Tauri takes the native drag events before the page sees them; the tree's
file-and-folder drag is a press, a 5px threshold, `elementFromPoint`, and a
drop on release (src/FileTree.tsx:327–453), and the bug log carries the scar
that mandates it. A repo drag is the same gesture with a shorter vocabulary.

The pattern to copy is not the tree's own drag, though — it is the tab
strip's. Tabs reorder *live under the pointer*, computing an insertion index
from midpoints as the pointer moves (src/App.tsx:2725–2731, and the midpoint
scan just below), and that is the right feel here too: a list that visibly
gives way tells you where the drop will land without a separate indicator.
Repo headings differ from tabs only in axis (y, not x) and in count — a
handful, so re-rendering the list on every crossing costs nothing.

## The collision to design around

The repo heading is already a drop target: it carries
`dropSpot(r.path, "", ...)` so a file dragged onto it lands at that
repository's root (src/FileTree.tsx:850–853). And the heading has no
`dragHandle` today — only files and folders press into a drag
(src/FileTree.tsx:335, 532) — which is why adding one is possible at all, but
also why the two drags must be told apart by *what was pressed*, not by where
the pointer is.

So the carried item grows a kind. Today `carried` is
`{ repo, path, kind: "file" | "dir" }` (src/FileTree.tsx:299, 397); a press on
a heading carries `kind: "repo"` instead. The move handler branches early: a
repo drag never consults `allowed` (src/FileTree.tsx:370–382), never lights
folder drop spots, and never sets the `tree-drag` body class — that switch
turns on the split pane's drop zone (src/FileTree.tsx:401,
src/App.css:2800–2840), and a repository cannot open in the split. It only
computes an insertion index from the headings' y-midpoints and asks App to
reorder on release. Conversely a file drag keeps treating headings as root
drop targets, untouched.

The same guard that keeps a click a click applies: the existing
`didDrag`/click-swallow dance (src/FileTree.tsx:323, and `swallowTabClick`'s
twin) must cover headings too, or every reorder would end by collapsing the
repository it dropped — the heading's click is a toggle
(src/FileTree.tsx:848).

## App's side: one callback

`onReorderRepo(fromPath, toIndex)` beside `onForgetRepo`/`onRenameRepo` in the
tree's props (src/FileTree.tsx:185–187), implemented in App as a splice on
`setRepos`. By path, not by index, on the from side: the tree renders
`shownRepos`, an overlay-mapped copy (src/App.tsx:231–236), and indexes into a
derived array are exactly the kind of thing that goes stale between the press
and the release. The to side is an index because "between these two headings"
*is* an index, computed by the same component that will re-render from the
result — self-consistent by construction.

Live reorder during the drag would mean lifting `repos` mutations into
pointer-move, which crosses the memoized tree boundary on every crossing
(`FileTree` is `memo`, src/FileTree.tsx:~460). With a handful of repos that is
affordable — the tab strip already pays it — so start live; if it ever
stutters, degrade to an insertion line and a single reorder on release. The
fallback is strictly less code, which is the right direction for a fallback.

## What this is not

Not sorting. A `treeSort`-style setting for repositories ("by name", "by
recency") would fight the whole point: the order is an opinion, and the drag
is how the opinion is expressed. And not cross-window or synced anywhere —
`KEY.repos` is per-app localStorage (src/App.tsx:868), and a personal shelf
order is exactly the kind of thing that should stay personal.

## Open questions

- Where does a *dropped folder* repo land? Dropping a folder from Finder adds
  a repository (the drop handler routes it to the same append), and a new repo
  appending to the bottom is predictable — but an argument exists for
  inserting where it was dropped. Leaning append: the drop already means "add",
  and overloading its y-position doubles the gesture's meaning.
- Does the drag need an affordance? Headings today communicate click-to-toggle
  and right-click-for-menu. A grab cursor on press-and-hold may be enough; a
  permanent grip icon is furniture the sidebar has so far refused.
- Keyboard parity: "Move up/down" in the heading's context menu
  (src/FileTree.tsx:812–830 region) is two lines each and makes the feature
  reachable without a steady hand. Cheap enough to include in the first pass?
- Should the filter suppress the drag? While `filter` is non-empty the tree
  shows matches only (src/FileTree.tsx:846 `filtering`) — reordering a
  filtered list is well-defined (headings all still render) but feels like
  rearranging a search result. Probably allow it and not care.

## Next

- [ ] `kind: "repo"` joins the carried union; `dragHandle` on the repo
      heading, branch in the move/up handlers that computes an insertion index
      from heading midpoints and skips drop-spot logic and the `tree-drag`
      class entirely
- [ ] Click-swallow extended to headings so a drop does not toggle the repo
- [ ] `onReorderRepo(fromPath, toIndex)` prop; App splices `repos`,
      persistence rides the existing `KEY.repos` effect
- [ ] Live reorder under the pointer, tab-strip style; insertion-line fallback
      only if it visibly stutters
- [ ] Context-menu "Move up" / "Move down" for keyboard parity, if the open
      question resolves yes
- [ ] e2e: drag the second heading above the first, assert tree order and
      that it survives reload; drag ending on a heading does not collapse it;
      a file drag onto a heading still moves the file to that repo's root
