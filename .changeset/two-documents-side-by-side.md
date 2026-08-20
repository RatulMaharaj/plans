---
"plans": minor
---

Two documents, side by side. Drag a file — from the tree or from the tab
strip — onto the dashed "Open beside" zone along the page's far edge and it
opens beside the one you are reading. Once a split is open the zone stays
away — the pane itself is the target, outlined under the drag, so nothing
ever promises a third pane; a drop there retargets it. The tab row itself splits: each pane carries its
own strip and its own header — path, status badge, owner, due — sized to its
pane. Tabs move rather than copy: dragging the open document to the side
lets the next tab fill its place (or the blank state show), a split tab
dropped on the main pane comes back, and tabs reorder live under the pointer
within a strip. ⌃Tab cycles the focused pane's own strip.

The split's header carries a Frontmatter button, like the main one — no
close button: the pane closes from the palette ("Close the split") or when
its last tab does. "Swap the panes" trades the two tab sets wholesale, and
"Open this document in both panes" puts two live views on one file — a save
in one is the other's outside edit, taken silently when clean and raised as
the conflict bar when both have typed. There is one view switch, in the chrome, and it acts on whichever pane
has focus; the split offers Write and Source, and no Diff. ⌘\ does the same from the keyboard, opening the
most recent other buffer in a second pane — its own view, its own scroll, its own save machinery against
its own stamp, so a save in one pane can never use the other's. ⌘⌥\ turns
the split the other way, ⌘⌥1/⌘⌥2 move focus between panes (the bare digits
stay the view switch), and ⌘W closes the focused split before it closes
buffers. The divider drags, double-click evens it out, and the split — which
way it runs, where the divider sits, what it shows — survives a restart.

Opening a file while the split has focus loads it there; a file already open
in the other pane moves focus instead of opening a second copy, because two
editors saving one file against two stamps is the conflict machinery firing
on the app's own edits. Zen collapses to one pane and restores the split on
the way out. Two panes and no more, deliberately.
