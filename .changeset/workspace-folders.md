---
"plans": minor
---

A workspace is a folder of files, not one document. It joins the file tree as
a heading of its own, with its folders and files under it, and takes the same
gestures a repository does: new file, new folder, rename, move, delete —
each one a transaction on a shared tree, so everyone in the workspace sees it
land at once and two people acting together merge rather than fight. A rename
carries the document with it, so whoever is mid-sentence in a file stays
mid-sentence in it. What is disk-only goes dark for a workspace: no git marks,
no Reveal in Finder, no terminal, no path to copy.

The read endpoint and share links reach files rather than workspaces:
`GET /w/{id}/` lists the folder, `GET /w/{id}/{path}` answers with one file,
and a share link names the file it opens — the viewer draws mermaid fences as
diagrams now, too. `plan.md` keeps answering everywhere it used to, and a
workspace made before this keeps its document under that name.

The review gate is retired. `status:` in the file's own frontmatter and
`approved` as a human's word say what the gate said, and they travel with the
file into the repository instead of staying behind on a server; the page head
shows the file's status badge, as it does for any other file. Copying a plan
out to a repository revokes the workspace's share links, since the document
they point at is a file with a repository's own rules now.
