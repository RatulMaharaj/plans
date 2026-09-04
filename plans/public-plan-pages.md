---
status: done
---
# A public page for any plan

> On the link sharing. This is a feature which should allow me to share any
> plan with others so they can just read it publically, unauthenticated in
> their browser. We might just need to host the markdown renderer part of
> the app as the home route at plans.looped.sh/[planId] and have the other
> communication done via plans.looped.sh/api

## Problem

`sharable-links.md` shipped a link into a workspace document: a token in the
URL fragment, a hand-written renderer in one HTML file, revocable per
workspace. Two things about it are wrong for what is wanted. It only reaches
workspace documents, and most plans live in repositories on someone's disk.
And its page is a second renderer that will always lag the app's: no
mermaid, its own idea of a table, its own idea of a comment.

## Approach

- **A share is a published plan.** The server holds published plans:
  `id`, markdown, name, who published it, when, and where it came from -
  a workspace file, or a repository file named by repository and path.
  Sharing from the app publishes; while sharing is on, every save of that
  file republishes, so the page follows the author. Stopping sharing
  deletes the page. A workspace file needs no copy: its page reads the live
  document, and follows it as it changes.
- **The page is `plans.looped.sh/{id}`.** The id is the secret: long,
  random, and the whole of the URL. A page nobody has the URL for is
  unreachable; a URL that leaks is revoked by stopping the share. No
  session, no fragment, no token: a public page is public, and its address
  is what is shared.
- **The renderer is the app's.** A second Vite entry, `share`, builds the
  read-only half of the app - the markdown pipeline, the HTML view, mermaid,
  the frontmatter chip, the theme - into static files the server serves.
  The same source the editor renders from, so the page and the app never
  disagree. The server's `/` and `/{id}` serve that build; everything the
  app talks to moves under `/api`, and the websocket to `/api/ws/{id}`.
- **The old link keeps answering.** `/share#token` resolves the token to the
  workspace document and redirects to its page, until the last such link
  has expired.

## Implementation guide

- [x] `server/src/schema.js` + a migration - `pages`: id, source (workspace
      document or repository + path), markdown, name, published by, at,
      revoked at
- [x] `server/src/index.js` - routes under `/api`; `GET /api/pages/:id`
      answers the markdown (live, for a workspace source); `POST
      /api/pages` publishes or republishes; `DELETE /api/pages/:id` stops
      sharing; `/` and `/{id}` serve the static build; `/share#token`
      redirects
- [x] `src/share/` - the second Vite entry: fetch the page, render it with
      the app's pipeline, follow a live source by polling; a 404 page that
      reads as "this plan is not shared", never as an error
- [x] `vite.config.ts` - the `share` entry, built into `server/public/`
- [x] `server/Dockerfile` - build the entry in the image, so the server
      ships its own page
- [x] `src/workspace.ts` - the `/api` prefix; publish, republish on save
      while sharing, stop
- [x] `src/App.tsx` - "Share" on any file's page head: publish and copy the
      URL; a shared file shows a small mark and a "Stop sharing"; the
      workspace's share sheet becomes this
- [x] `e2e/workspace.spec.ts` + `server/test/` - a repository file shared
      from the app appears at its URL to a browser with no session, follows
      a save, and disappears when sharing stops; a workspace file's page
      follows the room

## Out of scope

Comments or reactions on the page, a listing of one's shared pages, custom
slugs, and anything about who may share: anyone signed in may share
anything they can read.

## Open questions, as answered

- **Websocket or polling?** Polling, every five seconds. A reader is not a
  collaborator, and a socket per reader is a cost the page does not need. The
  page stops asking once the plan is gone, which is the only final answer.
- **A "last published" time?** Yes, for a repository file — its page is a
  copy, so how fresh it is a real question. A workspace document's page reads
  the room and has no "then" to report, so it says nothing.
- **Relative links to other plans?** They render as links and do nothing when
  clicked: there is no repository behind the page to open them in, and
  following one would land the reader on a 404 dressed as a plan. Anything
  with a scheme opens in a new tab.

One thing the approach did not decide, decided here: **the app remembers
which of its files are shared, not the server** (`src/shared.ts`,
localStorage). The server cannot honestly answer "is this file shared?" — a
page's id is its whole secret, and an endpoint that traded a repository path
for one would be a way to ask after other people's pages. The cost is that
the "Shared" mark follows the machine rather than the person; the page keeps
working either way.
