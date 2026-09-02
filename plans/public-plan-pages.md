---
status: ready
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

- [ ] `server/src/schema.js` + a migration - `pages`: id, source (workspace
      document or repository + path), markdown, name, published by, at,
      revoked at
- [ ] `server/src/index.js` - routes under `/api`; `GET /api/pages/:id`
      answers the markdown (live, for a workspace source); `POST
      /api/pages` publishes or republishes; `DELETE /api/pages/:id` stops
      sharing; `/` and `/{id}` serve the static build; `/share#token`
      redirects
- [ ] `src/share/` - the second Vite entry: fetch the page, render it with
      the app's pipeline, follow a live source by polling; a 404 page that
      reads as "this plan is not shared", never as an error
- [ ] `vite.config.ts` - the `share` entry, built into `server/public/`
- [ ] `server/Dockerfile` - build the entry in the image, so the server
      ships its own page
- [ ] `src/workspace.ts` - the `/api` prefix; publish, republish on save
      while sharing, stop
- [ ] `src/App.tsx` - "Share" on any file's page head: publish and copy the
      URL; a shared file shows a small mark and a "Stop sharing"; the
      workspace's share sheet becomes this
- [ ] `e2e/workspace.spec.ts` + `server/test/` - a repository file shared
      from the app appears at its URL to a browser with no session, follows
      a save, and disappears when sharing stops; a workspace file's page
      follows the room

## Out of scope

Comments or reactions on the page, a listing of one's shared pages, custom
slugs, and anything about who may share: anyone signed in may share
anything they can read.

## Open questions

- Should a page update live over a websocket rather than by polling? Cheap
  to add later; polling every few seconds is enough for a reader.
- Does a page for a repository file show a "last published" time, so a
  reader knows how fresh it is?
- A plan links to other plans by relative path. On the page those links go
  nowhere unless the linked plan is also shared; should they render as
  plain text, or resolve when a shared page exists for the target?
