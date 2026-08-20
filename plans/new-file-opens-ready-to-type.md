---
status: done
---
# A New File Opens Ready To Type

Naming a new file leaves you looking at it rather than writing in it. The
document opens, the heading is there, and the cursor is still wherever it was
before — so the first thing you do after making a file is click into it.

`createFile` (`App.tsx:1189`) does four things: writes the file, refreshes the
tree, opens it, refreshes git status. Nothing in that sequence puts focus
anywhere, and no part of the app ever calls `focus()` on the editor — a grep
for it across `App.tsx`, `Editor.tsx` and `SourceView.tsx` returns nothing.

The text to land in already exists. `create_plan` (`lib.rs:599`) writes
`# {title}\n\n` — a heading and an empty paragraph after it — so this is not
about inserting a line, only about putting the cursor in the one that is
already there. The cursor wants the end of the document, not the end of the
heading: the title has just been typed into the name sheet, and retyping it is
not what anyone wants next.

## The obstacle is that `Editor` has no way to be told anything

`Editor` renders a bare host div (`Editor.tsx:510`) and exposes no ref, no
imperative handle, and no prop that means "now focus". The app's one existing
channel into it is `htmlBridge` (`html-view.ts:287`) — a module-level object
of nullable functions, set by `Editor` when it builds and cleared on destroy
(`Editor.tsx:410-412`).

That is the mechanism to reuse. It is already the established way App reaches
into the live editor, and it already has the lifecycle handling that matters:
the null-out on destroy is what stops a stale closure focusing an editor that
no longer exists.

```ts
/** Set by Editor: put the cursor at the end of the document and focus it. */
focusEnd: (() => void) | null;
```

Implemented next to the others via `crepe.editor.action`, the same shape as
`htmlBridge.comment` (`Editor.tsx:280`): take the view from `editorViewCtx`,
build a `TextSelection` at `doc.content.size`, dispatch with `scrollIntoView()`,
then `view.focus()`.

## The second obstacle is timing, and it is the one that will bite

The editor is **swapped, not remounted**. `swap()` (`Editor.tsx:440`) runs from
an effect keyed on `docKey` (`Editor.tsx:481-495`), and `openFile` sets
`docKey` (`App.tsx:984`) as part of its own work.

So the obvious implementation is wrong:

```ts
await openFile(repoPath, relPath);
htmlBridge.focusEnd?.();          // focuses the *previous* document
```

`openFile` resolving means the state update was requested, not that React has
re-rendered and the swap effect has run. Focus placed here lands in whatever
document the editor currently holds, and the swap then replaces it — so the
call either does nothing visible or, worse, briefly puts the cursor in the file
you were reading before.

Focus has to be requested and then honoured by the swap, rather than called by
the caller racing it:

- `createFile` sets a one-shot flag — a ref, not state, since nothing renders
  from it: `focusOnNextSwap.current = true`.
- It is passed to `Editor` the same way `docKey` is, or read from a second
  bridge field set by App.
- `swap()` consumes it at the end and unsets it. The exact place is inside the
  `requestAnimationFrame` in its `finally` (`Editor.tsx:459-461`), where
  `swapping.current` is set back to `false` — the frame's whole purpose is
  letting the replacement transactions settle, and focusing before they have is
  focusing a document that is still being built.
- One-shot is the whole point: it must not fire again on the next file.
- `swap()` also has an early return that **queues** the text when the editor is
  not built yet (`Editor.tsx:441-446`). Creating a file as the very first thing
  after launch takes that path, so the request has to survive it and be honoured
  when the queued document is finally applied — not dropped on the floor.

## Only on creation

Opening a file must not steal focus. Clicking through the tree to read
something and having the cursor land in it is how you type into a document you
meant to skim — and it would fight
[`esc-unfocuses-the-editor.md`](./esc-unfocuses-the-editor.md), which is about
getting *out* of the editor deliberately.

So the flag is set only in `createFile` (`App.tsx:1189`), never in `openFile`
(`App.tsx:961`).

## Where focus goes when the sheet closes

`NameSheet` is a modal (`naming` state, `App.tsx:171`). It takes focus while
open and `createFile` closes it with `setNaming(null)` on its first line,
before any of the async work. Whatever the browser does with focus when that
subtree unmounts happens *before* the document has even been written, so it
cannot be relied on — another reason the focus step belongs at the end of the
swap rather than anywhere near the sheet.

## Interaction with the view switch

If the new file opens in source rather than write — which is what
[`view-mode-per-buffer.md`](./view-mode-per-buffer.md) makes possible per
buffer — then the cursor belongs in CodeMirror, not in Milkdown. Today `view`
is app-wide, so a new file created while you are in source view lands in the
source editor.

The clean version is that "focus the buffer" is one intent that the active view
answers, rather than a Milkdown-only call. That is a small interface decision
worth making now even while there is only one implementation, because
retrofitting it after per-buffer modes land means touching both.

## Open questions

- Should the cursor go to the end of the document, or should the **heading text
  be selected** so the first keystroke renames it? Selecting the title is what
  Finder does for a new folder. Against it: the title was just typed into the
  sheet, so offering to replace it immediately is offering to undo the thing
  you just did. End of document is the assumption here.
- Does the same apply to **new folders**? `create_folder` has nothing to focus,
  so probably not — but creating a folder and then a file in it is the common
  path, and that ends at this same code.
- What if creation happens while the **settings page** is open? `openFile`
  already leaves settings (`App.tsx:993`), so the focus should follow — worth
  an explicit check rather than an assumption.
- Should this be **one mechanism with the palette**? "Create file" from the
  palette, from the tree's right-click, and from the empty state all funnel
  through `createFile`, so they all get it for free — that is an argument for
  keeping the flag in `createFile` and not at the call sites.

## Done when

- Naming a new file leaves the cursor in the empty paragraph under the heading,
  ready to type, with no click.
- Opening an existing file does not move focus.
- Creating a file while a different document is open never puts the cursor in
  the old document, even briefly.
- The flag is one-shot: the file opened after a created one does not steal
  focus.
- Destroying the editor mid-flight cannot fire focus at a dead view.

## Next

- [ ] `htmlBridge.focusEnd`, implemented via `editorViewCtx` and cleared on
      destroy alongside the others
- [ ] A one-shot focus request consumed at the end of `swap()`, not called by
      `createFile` after `openFile` resolves
- [ ] Set it only in `createFile`
- [ ] Decide end-of-document versus select-the-title before building it
- [ ] A test: create a file, type immediately, assert the text landed in the
      new document. The harness already creates one through the tree's
      "New file here" (`app.spec.ts:329`), so this is an assertion on top of a
      path that is already driven.
