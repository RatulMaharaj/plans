---
status: ready
---
# Improve the comment system in workspaces

A comment in this app is a line of the document: `<!-- @name: text -->`,
parsed by `COMMENT` (`src/html-view.ts:23`), rendered as a card with one turn
per voice (`html-view.ts:81-113`), replied to by appending a line
(`withReply`, `html-view.ts:64-72`). The signature is whatever git happens to
say: `author` is `git config user.name` per repository, slugged
(`src/App.tsx:668-677`, `App.tsx:722`), and when git says nothing the comment
goes in unsigned (`App.tsx:741`).

That was the right design for a folder of files on one person's disk — git's
name is the only identity a local repository has. A workspace is the opposite
situation: everyone in the room has *signed in*. The server knows who you are
(`Account` is `{ login, name, avatar }`, `src/workspace.ts:43`), presence
carries your name, colour and face to everyone's screen
(`workspace.ts:241`), membership is a list of logins the server enforces
(`workspace.ts:50`), and yet the moment you comment on the document you are
arguing in, the app forgets all of it. `author` is derived from
`activeRepoPath` (`App.tsx:722`), a workspace buffer has no repository, so
every workspace comment lands anonymous — and the prompt even offers the
wrong advice, "git config user.name would sign it" (`App.tsx:735`), to
someone whose name is drawn on the page head at that moment.

## Sign with the account, and with its login

The fix is one derivation, because the plumbing was built for it. `Editor`
takes an `author` prop (`src/Editor.tsx:35`) and both panes already pass it
(`App.tsx:6110`, `App.tsx:6198`); it flows into `htmlContext.author`
(`Editor.tsx:269`, `Editor.tsx:799-800`), which signs replies and names the
reply field (`html-view.ts:119`, `html-view.ts:128`). So the change is where
`author` comes from: when the active buffer is a workspace document
(`wsIdOf(activePath)` already answers this at `App.tsx:6125`), the author is
the signed-in account, not the repository's git identity.

Which string, though — the display name or the login? The login. Three
reasons:

- **It is the identity the server enforces.** Invites are by login
  (`workspace.ts:196`), membership is logins (`workspace.ts:50`), ownership
  is compared against `account.login` (`App.tsx:5651`). A comment signed
  `@ratulmaharaj` names a member; a comment signed `@ratul-maharaj` — the
  slug of a display name (`authorSlug`, `html-view.ts:51-57`) — names nobody
  the server has heard of, and two members with the same display name
  collapse into one voice.
- **It is stable.** A display name is self-declared and editable; the login
  is the key everything else already hangs off, including the presence
  colour (`colorFor(account.login)`, `App.tsx:3196`).
- **It already fits the format.** Logins are handle-shaped; they pass
  through `authorSlug`'s character class untouched, so nothing about the
  parser or the thread-detection rule (`html-view.ts:31-34`) changes.

The unsigned fallback stops being reachable in a workspace: you cannot be in
the room without a session (`openRoom` requires one, `workspace.ts:300`), so
`account` is always there when a workspace buffer is active. The fallback
stays for repositories, where it is honest. The `newComment` note
(`App.tsx:733-735`) should say which identity will sign — `@login` in a
workspace, the git name in a repository — because the signature is the one
part of a comment the writer does not type and should not be surprised by.

## Faces on the turns

The comment card writes `@name` as plain text (`html-view.ts:105-106`),
while ten lines up the page the same person has a colour and a face: the
foot profile draws both (`App.tsx:5677`), presence cursors carry both
(`workspace.ts:241`), and `Avatar` exists precisely to turn
`{name, color, avatar}` into a face. In a workspace the card should look up
each turn's `who` against the members and render the face and the presence
colour beside the handle — the same identity, the same colour, everywhere it
appears. That consistency is the actual feature: a thread where each voice
matches a cursor you have watched move is legible in a way `@handle:` text
is not.

The lookup is the only real work. The `Workspace` payload carries logins
only (`workspace.ts:50`); avatars and display names arrive via presence,
which covers exactly the members currently connected — a thread's earlier
voices are usually people who have left. So the server should answer member
*profiles* (login, name, avatar) rather than bare logins, either by widening
`members` in the workspace payload or as a small members endpoint next to
invite (`workspace.ts:196`). The card component stays shared: `commentCard`
takes its context from `htmlContext` (`html-view.ts:275`), which can grow an
optional `profiles` map that repositories simply never set — the repository
rendering does not change by a pixel.

## What deliberately does not change

**The format.** Comments stay HTML comments in the markdown, threads stay
one line per turn. This is load-bearing, not legacy: "Copy to repository…"
writes the workspace document into a repo as an ordinary file, and the
threads travel with it verbatim; agents read them as text; the share page
renders them with the app's own pipeline — "the same Editor, the same
markdown pipeline" is the share page's stated design
(`src/share/Page.tsx:4-6`). A server-side comment store would fork the
document into "the text" and "the conversation about the text", and the
second half would be lost by every consumer that matters here — the whole
point of the app is that the file is the product (the agents that implement
a plan read the file, not our database). The CRDT already merges concurrent
comment edits the way it merges any text; there is no sync problem left to
solve.

**Anchoring.** A comment sits where the cursor was (`Editor.tsx` puts it in
at the cursor via `htmlBridge.comment`, `src/Editor.tsx:416-420`), not
attached to a character range. Range-anchored comments à la Google Docs need
positions that survive collaborative editing — Yjs relative positions can do
it, but the anchor would have to live outside the markdown, which reopens
the fork the previous paragraph closed. A comment that sits as a line in the
prose it discusses is cruder and survives everything: copy, publish, agent
edits, `git diff`. Not v1, and arguably not ever.

## Open questions

- **Should repository comments learn the account too?** Someone signed in to
  workspaces who comments in a repository buffer still signs with git's
  name. Leaving it is defensible — a repo file's collaborators are git
  collaborators, and the git name is what `git blame` will agree with — but
  the same person signing two different handles in two buffers is a wart.
  Leaning: leave it, and let the note text name the identity so the
  difference is at least visible.
- **What does a mention do?** The thread rule treats `@handle:` at
  line-start as a turn (`html-view.ts:31-34`), but `@handle` in a comment's
  prose is a mention with no consequence — there is no notification surface
  anywhere in the app. Autocompleting members after `@` in the comment field
  would be cheap and honest (it names people correctly, promises nothing).
  Actual notification is a server feature with an email or badge story, and
  belongs to its own plan.
- **Old unsigned comments.** Workspaces already contain comments written
  before this change, unsigned or signed with git slugs. They render fine —
  `who: null` turns say "comment" (`html-view.ts:106`) — but should the
  members lookup try to claim `@ratul-maharaj`-style slugs by matching
  display names? Leaning no: a fuzzy identity match that is wrong once is
  worse than a plain handle that is merely plain.
- **Does the share page get faces?** It renders with the same pipeline, but
  its readers are anonymous and the page deliberately never carries the
  member list — the sharable-links plan made that a privacy property. Faces
  on a public page would leak exactly what was withheld. Probably: handles
  and colours only, no avatars, on `/share`.

## Next

- [ ] Derive `author` from `account.login` when the active buffer is a
      workspace document (`App.tsx:722`, using `wsIdOf` as at
      `App.tsx:6125`); keep the git path for repositories
- [ ] Fix the `newComment` note to name the signing identity per context
      (`App.tsx:733-735`)
- [ ] Serve member profiles — login, name, avatar — beside or instead of the
      bare `members` logins (`workspace.ts:50`, `workspace.ts:196`)
- [ ] An optional `profiles` map on `htmlContext` (`html-view.ts:275`);
      `commentCard` renders face and presence colour for a turn whose `who`
      is a member (`html-view.ts:105-106`), and stays text-only otherwise
- [ ] Autocomplete member handles after `@` in the comment and reply fields
- [ ] Decide the share-page rendering (colours yes, avatars no?) and make
      `/share` match the decision
- [ ] A test: two accounts in one workspace produce a two-voice thread with
      both handles, and the copied-to-repository file carries it verbatim
