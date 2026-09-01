---
"plans": minor
---

Share a workspace document with a link. "Share…" in a workspace's page head —
or "Copy share link" in the palette — mints a link anyone can open in a
browser with no account, no app and no clone: the document at reading width,
read-only and live, with the workspace name and its status and review chips,
and a print stylesheet so ⌘P is the export button. The secret rides in the
URL's fragment, which browsers never send, so the server's log and any link
unfurler see an empty `/share` page and nothing of the document, and the page
carries the review state but never the member list. Each link is its own
token: the same sheet lists the live ones and revokes them one at a time, and
revoking one breaks neither the others nor the read token the factory holds. A
link also expires thirty days after minting — revocation answers the leaked
link, expiry answers the forgotten one — and expired, revoked and never-minted
all read alike. The app also now points at the workspace server's `looped.sh`
address by default, so links are minted from the right place.
