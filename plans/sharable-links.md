---
status: ready
---
# sharable links

Any markdown file in a workspace should be sharable with a link: send a URL
to someone with no account, no app, no repo clone, and they see the plan
rendered clean and read-only in their browser. Today a workspace document has
two doors — a member's session and the factory's bearer token
(server/src/index.js:137–149) — and both require holding a secret in a
header. There is no door a browser can walk through.

## This looks like it contradicts hosted-workspaces, and mostly doesn't

The hosted-workspaces plan argued *against* exactly this: "Not a public URL
with an unguessable id: plans are unreleased intent, and 'security by long
id' fails the first time a URL lands in a CI log"
(plans/hosted-workspaces.md:154–159). That argument was about the *agent*
endpoint — a URL that gets pasted into factory secrets, CI configs, and logs
as a matter of course, where it will be copied by machinery that doesn't know
it's secret.

A share link is a different speech act. It is a person deliberately
publishing one document to chosen readers, the way a Google Docs "anyone with
the link" URL is. The residual risk — the link travels further than intended —
is answered with *revocation*, not with pretending the link isn't a
capability. Each link is its own token, listed and revocable, and killing one
link breaks neither the other links nor the factory's read token. The
hosted-workspaces open question about invite links named "tokens-in-links" as
the tension (plans/hosted-workspaces.md:186–188); this plan resolves it for
the read-only case, which is the easy half — a leaked share link shows
someone a draft, it doesn't let them edit it or join the room.

## The secret rides in the fragment

The one genuinely new trick, and it dissolves most of the CI-log worry: the
link is

```
https://workspaces.plans.looped.sh/share#<token>
```

Browsers never send the fragment over the wire. The server's access log, any
proxy in between, and any unfurler that fetches the URL see only `/share` —
a static viewer page with nothing in it. The viewer's JavaScript reads
`location.hash` and fetches the document with `Authorization: Bearer`, which
is the header discipline the server already speaks and its CORS headers
already allow (server/src/index.js:40–42). So the wire looks exactly like the
agent endpoint's wire; only the copy-paste surface carries the secret, and
that surface is revocable.

Two pleasant corollaries. The workspace id never appears in the URL at all —
the token *is* the address, resolved server-side the way
`workspaceForReadToken` already resolves the factory token
(server/src/db.js:217–223). And link unfurlers can't leak content: fetching
without the fragment yields the empty shell, so a link pasted in Slack
previews as "a plan on plans", not the plan.

## Share tokens are their own table, not read_tokens with a flag

The `read_tokens` table (server/src/db.js:43–48) is nearly the right shape —
hashed token, workspace, creator — and the temptation is a `kind` column.
Resist it: the two tokens have different lifecycles and different audiences.
The factory token is minted once, lives in secrets, and revoking it is an
operational event; share links are minted casually, plural, and revoked on a
whim, and the UI wants to list them ("created by @ratul, 3 days ago") without
ever listing the factory's credential next to them. A `share_tokens` table
with the same hashed-at-rest discipline (server/src/db.js:51–54), plus
`revoked_at`, keeps both stories simple. Three routes:

- `POST /workspaces/{id}/share` → `{ token }`, member-only via the existing
  `mine` guard (server/src/index.js:68–73)
- `GET /workspaces/{id}/share` → the list, for the revoke UI
- `POST /workspaces/{id}/share/revoke` with the token's id

The read side is one route, `GET /share/doc` with the bearer token, answering
with the same serialization everything else reads —
`rooms.markdown(id)` (server/src/rooms.js:72–83) — plus the workspace name
and review state, so the page can wear the status chip. Unknown or revoked
token: 404, in the same never-403 spirit as `mine`
(server/src/index.js:66–67), so a dead link confirms nothing.

## "Read-only PDF" means a page that prints, not a PDF

The draft's phrase is "render it as a read-only PDF (zen mode style)". Take
the style, not the format. Generating actual PDFs server-side means a
headless browser or a layout engine on a server whose whole ethos is "one
Node process" (server/src/index.js:1–3) — the moment it wants Chromium, the
scope has slipped. What the phrase is really asking for is the zen reading
experience: "one buffer and nothing else — no tabs, no header"
(src/App.tsx:4730), a mood the app deliberately doesn't even persist
(src/App.tsx:322–323). A static page with the app's typography, the document
centered at reading width, the workspace name and status chip small at the
top, and a `@media print` stylesheet gives everyone a PDF for free — ⌘P is
the export button, and the browser's PDF is better than one we'd render.

The viewer is one self-contained HTML file the server serves at `/share` —
no build step, no framework, a small markdown renderer inlined. It is *not*
the app's Milkdown stack; that stack exists to edit, and dragging it into a
static page imports its bundle for a read-only view. Two rendering rules
carry over from the file conventions: HTML comments are the comment format
(plans/collaboration.md:52–54) and stay invisible, which raw-HTML
*escaping* — the safe default for a page that renders strangers' input —
gives us anyway; and frontmatter is split off and rendered as the chip, not
as a stray `---` table, reusing the same line-based read `matter.ts` does
rather than a YAML library.

## Live, not a snapshot

The link shows the document as it is now, because `rooms.markdown` already
prefers the live room over the stored state (server/src/rooms.js:73–80). This
is the right default for what a workspace is — a plan mid-argument. A share
link that froze the text at mint time would routinely show reviewers a
version the authors have already moved past, which is worse than useless in a
review. The page fetches once on load; it does not join the websocket, hold a
read-only Yjs replica, or show presence. A reader who needs the newest
sentence refreshes. If live-following ever matters, it is an additive change
to the viewer, not a different design.

## Where the gesture lives in the app

"Copy share link" is a palette command and a small control in the page head
when the active buffer is a workspace doc — next to where review already
renders, since sharing and requesting review are siblings ("look at this" in
two strengths). It calls the new endpoint through `src/workspace.ts`'s
existing `call` plumbing, right beside `readToken`
(src/workspace.ts:162), builds the URL from `serverUrl()`
(src/workspace.ts:27–36) so a self-hosted server mints links to itself, and
puts it on the clipboard with the toast the app uses everywhere. Revocation
lives behind the same control: the list of links with a revoke button each,
in a small sheet, not a management page.

## "Any markdown file" is one file, for now

A v1 workspace is one document (plans/hosted-workspaces.md:163–165), so "any
markdown file in a workspace" collapses to "the document", and the token
scopes to the workspace exactly as the factory token does. When workspaces
grow multiple documents, the question of whether a link shares one file or
the workspace's set reopens — noted below rather than designed now, because
designing token scopes for documents that can't exist yet is how schemas rot.

## Open questions

- **Should a share link expire by default?** Revocation handles the leak
  story, but an expiry (30 days?) handles the *forgotten* link — nobody
  revokes what they don't remember minting. Leaning toward no expiry in v1
  and a "created N days ago" label that shames appropriately; expiry is a
  column we can add without a migration story.
- **Does the viewer get the review trail or just the state?** The chip needs
  `review.state`; showing "approved by @name" is more honest for a reader
  deciding how settled the text is. The share endpoint would return the same
  shape `db.workspace` already builds (server/src/db.js:91–103), minus the
  member list — is the member list itself something a link-holder should see?
  Leaning no: names of who's arguing are not part of the document.
- **Fragment survivability.** Some contexts rewrite or strip fragments
  (certain link scanners, copy-paste through software that "cleans" URLs). If
  a stripped link lands on bare `/share`, the page should say "this link is
  missing its key — ask for it again", not render an error that looks like
  revocation.
- **Mermaid and images.** The app renders mermaid blocks and repo-relative
  images; a workspace doc can contain both. Mermaid in the viewer is one
  script tag and probably worth it; images by relative path have no
  repository to resolve against and should render as a visible broken-asset
  placeholder, not vanish. Does that need saying in the doc, or in the
  viewer?
- **Should the copied-to-repo file remember its links?** Once the plan leaves
  the room for git, the workspace (and its links) live on. Do links keep
  working after copy-out — probably yes, the room is still the discussion —
  or should copy-out suggest revoking them as part of "the argument settled"?

## Next

- [ ] Point `DEFAULT_SERVER` (src/workspace.ts:25) at the workspace server's
      looped.sh address — the app now lives at plans.looped.sh, and share
      links are minted from `serverUrl()`, so a stale constant mints stale
      links
- [ ] `share_tokens` table (hashed, `revoked_at`) and three member-only
      routes: mint, list, revoke — 404 for unknown/revoked, like everything
      else
- [ ] `GET /share/doc` behind the bearer token: markdown from
      `rooms.markdown`, plus workspace name and review state
- [ ] `GET /share`: one static, self-contained viewer page — reads
      `location.hash`, fetches with the Authorization header, renders with
      raw HTML escaped, frontmatter as a status chip, zen-width column, print
      stylesheet; a distinct message for a missing fragment
- [ ] "Copy share link" in the palette and the page head for workspace
      buffers, via `workspace.ts`; a small sheet listing links with revoke
- [ ] e2e: mint a link in one context, open it in a fresh logged-out context
      and see the rendered heading; revoke it and see the 404 message; fetch
      `/share` with no fragment and see the missing-key message, not content
