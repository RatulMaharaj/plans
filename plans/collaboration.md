# Collaboration

The draft has three ideas — no accounts, markdown-native comments, UI grown
from frontmatter — and they turn out to be one idea: **everything collaborative
lives in the file, and the app only renders it**. The repo is the server, git
is the sync protocol, and a person is whoever `git config user.name` says they
are. Nothing here adds a backend, a login, or a sidecar database, and nothing
here writes a byte another markdown tool couldn't read.

## No accounts, but there is an identity

The app already knows who is committing — git does. `git config user.name`
resolves per repository through the existing `git()` helper (`lib.rs:27`), one
new command alongside `git_status` and friends:

- `git_identity(repo) -> { name, email }`

That name becomes the `@name` written into new comments, and it is exactly the
identity `commentAuthor` (`html-view.ts:26`) already parses back out on
render. Sign-in is `git config`, the same place it always was. If it's unset,
comments are written unattributed and render as "comment" instead of a name —
which the card already does (`html-view.ts:175`).

## Comments: the read side is built, the write side is missing

<!--
@ratul-maharaj: This is a test comment
@ratul-maharaj: I think something more than this could be another comment in a thread
-->

More of this exists than the draft assumes. Today:

- An HTML comment renders as a quiet "note" marker that opens a card on click,
  with the `@author` pulled out as a byline (`html-view.ts:153`)
- Editing goes through `htmlBridge.request` / `apply` (`html-view.ts:134`), so
  the raw text of a comment is already one click from a text box
- `htmlBridge.insert` places a new fragment at the cursor, and the palette's
  *Insert HTML* command already uses it (`App.tsx:2054`)

What's missing is the *gesture*: select some prose, comment on it. Two entry
points, both thin wrappers over what exists:

- **Right-click → New comment** on a selection in the page view. The editor has
  no context menu today (the tree does, `FileTree.tsx:392` — same pattern,
  same dismissal behaviour). The menu can stay one item long until something
  else earns a place on it.
- **A shortcut**, `⌘⇧M` (matching every other app that comments), plus a
  palette command next to *Insert HTML*.

Both open the same small prompt the *Insert HTML* path uses (`TextPrompt`),
pre-filled with nothing, and write:

```markdown
<!-- @ratul: this section undersells the conflict handling -->
```

placed **after the block containing the selection**, not inline at the cursor —
a comment splitting a sentence in half is technically valid markdown and
miserable to read as source. Anchoring is by proximity, not by range: the
comment sits under the paragraph it's about, which is what a human writing an
aside in markdown does anyway. No invisible IDs, no span markers, nothing that
degrades in another editor.

### Threads

A thread is just a comment with more than one voice in it. Keep it one comment
block, one line per reply:

```markdown
<!--
@ratul: this section undersells the conflict handling
@claude: agreed — pointed the paragraph at App.tsx:488 instead
@ratul: better. resolved.
-->
```

This costs nothing in the format — it's still a single HTML comment, still
invisible on GitHub, still greppable. The render side grows a little: when the
body contains multiple `@name:` lines, the card (`html-view.ts:171`) lays them
out as a list of turns instead of one text run, and gains a **Reply** field at
the bottom that appends a line and writes back through `htmlBridge.apply` —
the same round trip the edit path uses today, no new plumbing.

Resolving a thread is deleting the comment. The diff shows it, the commit
records who resolved it and when. Git is already the audit log; building a
second one inside the file would be the accounts mistake in another costume.

### Sync is already done

Nothing new to build here, and that's worth saying explicitly: comments travel
because the file travels. Pull picks up a teammate's comments through the
existing poll; the fingerprint save (`App.tsx`, the conditional-write path)
means two people commenting on the same file get the same conflict dialog two
editors always got. An agent can read and write the same comments with no API
at all — which, given [the memory of what this app is for](3_agents-flesh-out-plans.md),
is the actual headline: **comments are how a person and an agent talk inside a
plan**, in a format both already speak.

## Frontmatter-driven UI

`matter.ts` already splits the block losslessly and `matterKeys` lists its
keys; the sheet edits it as verbatim YAML. The draft's instinct — generate UI
from it — is right, but the failure mode is obvious: invent a schema, and the
frontmatter becomes the app's config format instead of the file's metadata.

So: **recognize a few conventional keys, render them read-only where they
help, and change nothing about editing.** The sheet stays the only writer.

- `status:` — a small badge in the page header next to the frontmatter button,
  and a tinted dot on the tree row (`FileTree.tsx` already rolls marks up
  through folders, `FileTree.tsx:117` — status can ride the same mechanism).
  Values are free text; a handful (`draft`, `active`, `done`, `blocked`) get
  colors, anything else renders neutral.
- `owner:` / `assignee:` — rendered as `@name` in the header, same treatment
  as a comment byline. With `git_identity` in hand, "assigned to me" is a
  filter the palette could offer later.
- `due:` — shown in the header; overdue gets the same quiet treatment the
  edited-mark uses, not an alarm.

Parsing is line-based like `matterKeys` (`matter.ts:65`) — no YAML library,
no nested structures. A key the app doesn't know is simply not rendered, and
the sheet shows it untouched. That's the whole contract: the app reads
conventions, it doesn't own a schema.

Statuses across many files invite a board view — status columns, drag to
change. That is a real feature and a separate plan; this one stops at badges,
because badges don't create any pressure on the file format and a board does.

## Open questions

- **Comment placement when the selection spans blocks** — after the last
  block, or one comment per block? Probably after the last; a reviewer writes
  one thought, not a scatter.
- **Should the quoted text go into the comment?** `<!-- @ratul re "the poll
  picks up files": … -->` survives paraphrasing better than proximity does,
  but makes comments long. Maybe only when the selection is short.
- **Timestamps in threads?** Git blame answers "when" already, per line.
  Writing dates into the comment duplicates that and goes stale on edit.
  Leaning no.
- **Does `@name:` collide with prose?** The line-per-turn parse should only
  trigger when *every* non-empty line matches `@name:`; otherwise render the
  body as one turn, exactly as today.
- **Is `status:` casing/vocabulary worth normalizing?** No — recognize
  case-insensitively, render what's written.

## Next

- [x] `git_identity(repo)` in `lib.rs`, cached per repo in `App.tsx`
- [x] *New comment* palette command + `⌘⇧M`, writing `<!-- @name: … -->`
  after the selection's block via a new `htmlBridge.comment` placement helper
- [x] Context menu on the page view, one item, patterned on the tree's
- [x] Multi-turn rendering in the comment card when every line is `@name:` —
  including comments written across several lines, gathered as a run the way
  `<picture>` blocks are
- [x] Reply field on the card, appending a line through `htmlBridge.apply`
- [x] `status:` badge in the header and dot on the tree row — the tree's read
  comes from Rust (`frontmatter_status`, head of the file only, cached by
  mtime), the header's from the open buffer's frontmatter
- [x] `owner:` and `due:` in the header, read-only
- [ ] Use it for a round of review on a real plan — one person, one agent —
  before deciding whether anchoring needs to be stronger than proximity

