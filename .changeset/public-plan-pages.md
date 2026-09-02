---
"plans": minor
---

Share any plan as a public page. "Share…" is now in every file's page head,
not just a workspace's: it publishes the plan to `plans.looped.sh/{id}` and
puts the address on the clipboard. A file in a repository republishes on
every save while sharing is on, so the page follows its author; a workspace
document's page reads the room, so it follows the argument. A shared plan
shows "Shared" in the page head, and the way to stop is behind it — stopping
kills that address for good. The id is the whole of the secret: no session,
no fragment, no token, and the page is not indexed.

The page is the app's own renderer, built as a second Vite entry
(`pnpm build:share`) and served by the workspace server, so mermaid, tables,
code, the frontmatter chip and the theme are the same ones the editor draws —
there is no second renderer to drift. Links minted before this land on their
document's page instead of the old viewer, which is gone. Everything the app
asks the server for moved under `/api` to leave the root to the reader; the
old addresses still answer, so a build already on your machine keeps working.
