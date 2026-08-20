---
"plans": patch
---

Mermaid diagrams zoom and pan. ⌘- or ctrl-scroll — which is also what a trackpad
pinch arrives as — zooms about the pointer, dragging moves the picture once
there is somewhere to move it, and double-clicking or the `1:1` chip in the
corner puts it back. A plain scroll still scrolls the document, since the
pointer is over a diagram for much of a long plan.

The zoom is remembered outside the widget rather than on it. ProseMirror keys
the diagram's widget by position, so typing a paragraph anywhere above one
rebuilds it — anything held on the node would be thrown away by an edit
elsewhere in the file.

The figure now clips at its frame. At 1:1 that changes nothing, because the
diagram is scaled to the width; zoomed, being cut off at the frame is the point.

A diagram can also be maximised, from the ⤢ in its corner — the same picture
with the room to read it, since zooming inside a frame the size of a paragraph
is the wrong size for the diagrams that most need looking at. Escape or the
backdrop closes it. The maximised view is built outside the editor entirely,
because the figure clips its overflow and anything inside the editor's DOM is
something ProseMirror believes it owns.

The `1:1` and maximise controls read as buttons in the document, not only in
the maximised view. Milkdown's own stylesheet strips the border and background
off any button inside the editor, and it does so with a selector that outranks
a plain class — so the same control looked like a button in one place and like
bare text in the other.
