---
status: ready
---
# Search Inside a File

We should be able to Cmd/Ctrl + F to search inside a file. Six words of seed,
and the right six: ⌘F is the oldest contract in text software, and this app —
an app for *reading* documents an agent wrote — does not honour it. The palette
searches across files (`*`, `Palette.tsx:557` by way of Rust's `search_plans`,
`api.ts:165`); nothing searches within the one on screen, which is where the
reading actually happens.

## One find, three surfaces

The trap in this feature is that "the file" is not one surface. A document is
shown three ways (`App.tsx:88`, `type View = "write" | "source" | "diff"`),
and the write and source views are both *editors*, both mounted at once with
the hidden one set aside by CSS (`App.tsx:3769`, `App.tsx:3792`). A ⌘F that
works in source and dies in write teaches people the binding is a gamble, and
they stop pressing it. So the design is one find bar, owned where the views
are switched, with a per-surface match engine underneath — the same shape as
the buffer itself, which is App's while the surfaces render it.

The two engines are honestly different amounts of work:

- **Source** is CodeMirror (`SourceView.tsx:14`), and CodeMirror has search as
  a first-party package — `@codemirror/search`, not currently a dependency
  (`package.json:22-28` has commands, language, state, view; no search). We do
  not want its stock panel: the app already replaces CodeMirror chrome that
  cannot be themed from CSS (`Editor.tsx:146`), and a second, foreign-looking
  find UI in one view is the inconsistency this section exists to avoid. Use
  the package's query machinery — `SearchQuery`, the highlight extension, the
  find-next commands — and none of its panel.
- **Write** is Milkdown over ProseMirror (`Editor.tsx:2`), which bundles no
  find at all. The engine is a small ProseMirror plugin: walk the doc's text
  nodes for matches, paint them with decorations, move the selection to the
  current one. Decorations rather than anything DOM-level (CSS highlights,
  `window.find`) because the document under a live editor redraws whenever the
  agent's write arrives through the watcher — a decoration set is recomputed
  with the doc and cannot be left pointing at text that moved. Matching runs
  over the *rendered* text, so searching "plan" finds it inside bold or a
  heading without anyone thinking about asterisks — which is also why a hit
  inside a collapsed thought or an HTML card is an open question below rather
  than a promise here.
- **Diff** is plain rendered divs (`DiffView.tsx:117`), not an editor. It gets
  nothing in the first cut. A read-only view of a transient comparison is the
  weakest claim on this work, and the browser-style answer there is different
  enough (no cursor to move) that bolting it on would smear the design.

## The bar

Small, floating over the top edge of the surface it is searching, in the
app's own chrome. An input, a count ("3 of 14"), next and previous. Enter is
next, ⇧Enter previous, Escape closes and returns focus to where the cursor
was — the same "back out" contract Escape already keeps (`keys.ts:66`).
Matches highlight as you type, the current one distinctly; the view scrolls to
it. No history, no regex toggle, no whole-word switch in the first cut: every
control on a find bar is a question the reader has to decline before typing.

With split panes in the app, "the file" is now "the focused pane's file"
(`App.tsx:3113`, save already answers this exact question with `paneFocus`).
⌘F searches the pane that has focus, and the bar sits over that pane —
anything else means the highlight appears somewhere you are not looking.

**Find, not replace.** Deliberately. Find is a reading tool and this is a
reading app; replace is an editing operation with a different blast radius —
in the write view it means programmatic transactions against a live Milkdown
document, the machinery that made `htmlBridge.apply` careful work
(`Editor.tsx:254`). The source view would get replace nearly free from
CodeMirror, but shipping it in one view and not the other is the same broken
promise as shipping ⌘F in one view. Replace is its own plan if it is ever
asked for.

## The key, and the doors

`mod+f` goes in the registry (`keys.ts:28`) as an unconditional binding —
"find in this document" does not depend on what is on screen, which is the
table's own admission test (`keys.ts:10`). That also buys remapping, the
palette hint, and the shortcut sheet for free, since all three are views of
the table (`keys.ts:2-8`). A palette command ("Find in this file") joins it,
because a binding nobody can find is a binding nobody uses.

One collision to settle now: the chat composer stops propagation only for
un-chorded keys (`ChatPanel.tsx:703` — "chords stay the app's"), so ⌘F pressed
mid-message will open find over the document. That is probably right — the
document is what you would be searching — but it is a decision, not an
accident, and the bar must not steal the composer's focus until you type in it.

## The half-finished neighbour

Cross-file search already finds lines (`search_plans` returns `relPath`,
`line`, `text` — `api.ts:165`) and then throws the line away: the palette's
run handler opens the file and nothing more (`Palette.tsx:828`, and
`App.tsx:4127` — `onOpenAt={(r, f) => void openFile(r, f)}` never reads a
line). Landing "at" a hit means landing at the top of the file and reading.

In-file find is the missing half of that feature. Once a surface can be told
"highlight this term and scroll to the current match", a `*` hit can open the
file *with the find seeded* — same bar, same highlight, query prefilled and
the match nearest the hit line current. That is worth doing in this plan
rather than after it, because it is the integration that proves the engine's
API is right: if seeding from outside is awkward, the bar owns state it
should not.

## Open questions

- What does ⌘F find inside content the write view renders specially — mermaid
  blocks (source kept, diagram beneath, `Editor.tsx:236`), HTML cards,
  collapsed frontmatter? Matching the underlying text but being unable to
  scroll to a visible highlight may be worse than skipping them; skipping them
  silently lies about the count. Probably: match, scroll to the enclosing
  block, and accept that the highlight is the block.
- Does the bar survive a view switch? The buffer is the same text in write and
  source, so carrying the query across `⌘1`/`⌘2` (`keys.ts:34-35`) feels
  right; carrying the *current match index* across two different coordinate
  spaces may not be worth its plumbing.
- Case sensitivity: smart case (insensitive until you type a capital) is the
  best default and needs no control — is that enough, forever?
- Highlight-all on a very large plan is the perf risk (every keystroke in the
  bar recomputes decorations). Debounce like the buffer's own 180ms report
  (`SourceView.tsx:115`), or cap highlighted matches and say "100+"?

## Next

- [ ] The find bar component: input, count, next/prev, Escape-restores-focus;
      one instance, positioned over the focused pane
- [ ] `mod+f` in `DEFAULT_KEYS`, the palette command, the shortcut sheet entry
- [ ] Source engine: add `@codemirror/search`, drive its query and highlight
      from the bar, no stock panel
- [ ] Write engine: ProseMirror decoration plugin — match over text nodes,
      current-match selection, scroll-into-view
- [ ] Seed the bar from a palette `*` hit: query prefilled, nearest match to
      the hit line current — and thread the line through `onOpenAt`
- [ ] Decide the special-content rule (mermaid, HTML, frontmatter) and make
      the count honest about it
- [ ] Measure find-as-you-type on the largest plan in the repo against the
      perf budgets before shipping the highlight-all default
