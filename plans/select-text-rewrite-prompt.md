---
status: done
---
# Selected text rewrite prompt

Select a passage in the editor, right-click → Rewrite…, say what you want in a
sentence, and the agent gets a turn that names the file, quotes the exact text,
and carries your instruction. The rewrite is the agent editing the file the way
every handoff already does — the app's file poll notices the write and the
buffer refreshes. No new backend, no new chat machinery: this is a third seed
on a path two features already walk.

## The shape: a seed, not a surgery

The tempting design is the surgical one: the app sends the selection to a
model, gets replacement text back, and splices it into the ProseMirror
document. That would need a new API call, a place to put an API key, streaming
into a live editor, and an undo story — a second, parallel way for text to
change that bypasses the save/watch/conflict machinery this app has spent most
of its bug list hardening (see BUGS.md, *Opening a file wrote it back*).

The cheap design is the honest one. "Hand off to agent" already turns a plan
into a seeded first message: `handOff` builds a prompt from a template and sets
`chatSeed` (src/App.tsx:1097–1115), the seed state lives at src/App.tsx:261,
and ChatPanel sends it exactly as if typed (src/ChatPanel.tsx:632–641). The
agent edits the file on disk; the stamp poll sees the write and reloads a clean
buffer — the same loop that makes every other agent edit safe. Rewrite is that,
with a selection and an instruction folded into the template. The whole
feature is frontend prompt assembly.

## Getting the selection out of the editor

The right-click menu in write mode is the page context menu: the surface's
`onContextMenu` opens it (src/App.tsx:4380–4384) and it renders with — its own
comment says so — "One item, until something else earns a place on it"
(src/App.tsx:4611–4628). Rewrite earns the second place, shown only when a
selection is non-empty; a menu item that scolds you for not selecting first is
worse than one that is absent.

App cannot read ProseMirror's selection and Editor cannot open App's sheets —
which is exactly the problem the `htmlBridge` exists to solve: "each side
registers what it can do" (src/html-view.ts:279–296). Editor registers one more
capability, a `selection: (() => string) | null` beside `comment` and
`insert` (src/Editor.tsx:309–354), returning
`state.doc.textBetween(from, to, "\n")` — the DOM's `window.getSelection()`
would also answer, but through decorations, widgets and mermaid figures it
answers with furniture the document doesn't contain. App calls it when the
context menu opens and stashes the string in the menu state alongside `x`/`y`
(src/App.tsx:382), so the menu decides what to offer from what was true at the
moment of the click, not at the moment of the press.

The instruction itself goes through the existing `asking` TextPrompt
(src/App.tsx:332–341) — multiline, confirm "Rewrite", the same sheet renames
and comments already use. No new component.

## Quote, don't point

The plan's original question was whether to send a line number or the exact
text, with a length threshold deciding. Argue it from what the agent actually
does: it opens the file and reads it. A quote is something it can find with
its own eyes; a line number is a claim about a file that may have moved since
the buffer was built — and *will* move the moment the agent starts editing
above it. Line numbers rot; quotes are self-verifying. So the quote is the
primary currency, always.

Two refinements rather than a threshold:

- **Long selections truncate, not switch.** Past ~50 lines, send the first and
  last few lines with an elision marker and say so ("the selection runs from
  the first quoted line to the last"). The endpoints still pin the region
  uniquely; sending three pages of quote into a prompt buys nothing.
- **Line numbers ride along as a hint, when they're honest.** The serialized
  buffer is already assembled in App (src/App.tsx:1745); if the quoted text
  occurs in it exactly once, compute its line range with `indexOf` and count
  newlines, and add "around lines N–M". If it occurs twice or — thanks to
  serialization drift between the ProseMirror doc and the markdown — not at
  all, say nothing. A hint that might be wrong is worse than no hint.

One thing must be true before any of this: the file on disk has to contain the
text being quoted. A dirty buffer hands the agent a quote from a file it can't
see. `handOff` gets away without flushing because it points at the whole file;
this seed points *into* it, so the rewrite path calls `flush()` first — the
same call `openFile` already makes before switching buffers (src/App.tsx:1906).

And it has to *check* the flush. A refused write — a conflict, a disk error —
leaves the quote describing a file that does not exist, and an agent handed
that goes and rewrites whatever it finds instead. So `flush` answers whether
the buffer reached disk, and the rewrite path sends nothing when it did not;
the conflict bar is already on screen saying why.

And "nothing pending" is not by itself an answer. The autosave timer may have
taken the buffer a moment ago and still be waiting on the write, so a flush
first waits out the write already in the air and adopts its result — otherwise
the seed goes out in the window where the buffer is claimed but the disk still
holds the old file.

## The template

A `REWRITE_PROMPT` in src/agent.ts beside `HANDOFF_PROMPT` and
`IMPLEMENT_PROMPT`, with a matching `rewritePrompt` setting, default, and
Settings textarea — the implement prompt just cut this exact groove
(src/agent.ts:14–42, src/settings.ts:97–107, src/SettingsPage.tsx:411–424),
and the same argument applies: a prompt you cannot see is a prompt you cannot
argue with. Placeholders `{file}`, `{quote}`, `{lines}` (empty when the hint
isn't honest), and `{ask}` for the typed instruction. Something like:

> In {file}, rewrite only the passage quoted below {lines}. {ask}
> Keep the surrounding voice and formatting, change nothing outside the
> quoted text, and do not touch any other file.
>
> > {quote}

The "nothing outside" clause is the seatbelt: the failure mode of handing a
whole file to an agent with a local instruction is a helpful global rewrite.

## What this is not

Not a diff-review flow. The agent writes, the poll reloads, and the Diff view
already exists for inspecting what changed (⌘-view switch) — building an
accept/reject overlay for rewrites would duplicate it. And not a source-mode
feature yet: the page menu only mounts on the write surface
(src/App.tsx:4380), and Source has CodeMirror's own selection world. Write
mode is where prose gets reworked; start there.

## Open questions

- The seeded turn lands in the file's current chat, mid-conversation if one
  exists. That is what handoff does too, and context about the plan probably
  *helps* a rewrite — but a long-running implement conversation might not be
  where a copyedit belongs. New chat per rewrite, or current chat? Leaning
  current, for the same reason handoff does.
- Should the selection survive until the agent's edit lands, so the reloaded
  buffer can scroll back to the rewritten region? Today the reload restores
  scroll by position (src/App.tsx:2145–2200), which is probably close enough.
- Split pane: the write surface exists in the split too. The bridge is a
  module-level singleton, so two mounted editors both writing
  `htmlBridge.selection` means last-mount-wins — the same hazard the other
  bridge entries already live with. Worth checking which editor owns the
  bridge before shipping, or scoping the menu item to the main pane.
- Is `{lines}` worth its complexity at all, given the quote self-locates? It
  is cheap (one `indexOf` on an already-assembled string), but it is the one
  part of the prompt that can silently lie.

## Next

- [x] The selection registered in Editor, returning
      `textBetween(from, to, "\n")`; cleared on unmount like its neighbours
- [x] Page menu state grows `selection: string`; "Rewrite…" item shown when
      non-empty (src/App.tsx:4715–4740)
- [x] `REWRITE_PROMPT` in src/agent.ts; `rewritePrompt` in settings defaults;
      Settings → Agents textarea beside the other two prompts
- [x] `rewriteSelection` in App: flush → compute quote (truncate past ~50
      lines) → line-range hint only on a unique match in `source` → `asking`
      prompt → `setChatSeed` + `set({ showMux: true })`
- [x] e2e: select in write mode, right-click, rewrite, assert the
      `agent_prompt` call contains the quote and the typed ask (pattern:
      e2e/chat.spec.ts's handoff tests)
- [x] e2e: no selection → no Rewrite item; dirty buffer → flushed before the
      seed is sent
- [x] e2e: a file changed underneath the edit → the conflict shows and no
      `agent_prompt` goes out
- [x] e2e: an autosave held in flight → the seed waits for it rather than
      quoting the file as it was

## What landed

The feature is the frontend prompt assembly the plan argued for, and nothing
else: no API call, no splice into the document, no accept/reject overlay.

- **The selection is a per-surface capability, not a bridge entry.** The plan
  asked for `htmlBridge.selection`; the split-pane open question then asked who
  owns a module-level singleton when two editors are mounted. Rather than ship
  the hazard and note it, Editor takes a `selectionRef` prop and registers a
  reader into it — exactly the shape `findRef` already has for ⌘F, and for the
  same reason (src/Editor.tsx:40–48, 195–225). App holds `mainWriteSelection`
  beside `mainWriteFind`; the split pane passes nothing, so the page menu can
  only ever quote the document that was right-clicked. The open question is
  answered rather than inherited.
- **The elision marker lives inside the quote**, not in the prompt's prose:
  past 50 lines the blockquote keeps three lines of each end with
  "… the selection continues; it runs from the first quoted line to the last …"
  between them (`quoteBlock`, src/agent.ts). `{lines}` stays purely the
  line-range hint, and stays empty unless `source.indexOf` finds the quote
  exactly once (`lineHint`).
- **The menu item is also gated on there being an agent** (`chat !== false`),
  the same rule the tree's handoff items follow — an item that cannot work is
  worse than one that is absent.
- Placeholders are filled in one pass through a replacer function: someone's
  prose containing `$&` must not become a substitution of its own.
- **The flush is checked, and the file is held.** `flush` now returns whether
  the buffer is on disk (`true` also when there was nothing pending), and the
  rewrite path drops the turn when it isn't — the only caller that cares,
  because it is the only one about to tell an agent what a file contains. The
  sheet also closes before the write finishes, so the seed re-opens the file it
  names if the active buffer moved while the write was in flight (`activeRef`,
  the same check `handOff` makes for a file that isn't open); a memory buffer
  has nothing to re-open, so that case drops the turn too. `flush` also waits
  out a write already in flight instead of reading an empty pending slot as
  proof of a saved file: the write itself lives in `writeOut`, and `flush` is
  the gate in front of it that adopts the in-flight answer (src/App.tsx). The
  e2e for it holds `write_plan` open with `__fake.stallWrites`.

Settled from the open questions: the seed lands in the file's current chat, as
handoff's does; scroll restoration is left to the existing by-position reload;
`{lines}` earns its keep because it is one `indexOf` and it stays silent when
it cannot be sure.

Not verified here (this run, and the review pass that followed it): no package
manager was available, so `tsc`, the settings-schema generator and Playwright
could not be run — the two
`settings.schema.json` copies were updated by hand to match what the generator
emits for a new prompt field (a `string` with the doc comment flattened into
`description`, and no `default`, exactly as the other two prompts have it). CI
runs `schema:check` and the e2e suite over this branch.
