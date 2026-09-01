---
"plans": minor
---

Workspaces: a room where a plan gets argued before it is a file. Sign in with
GitHub from the rail, make a workspace, invite people by login, and edit one
markdown document together with everyone's cursor in it. Request a review
when it settles; someone other than you approves it, which the server
enforces. "Copy to repository…" then writes the document into a repository
as an ordinary file, stamped `status: ready` and `approved-by:` when it was
approved, and everything downstream — agents, the factory, git — works as it
always has. The workspace server ships in this repository under `server/`,
one Node process with a SQLite file; the app keeps its session in the OS
keychain, never in `settings.json`.
