---
status: busy
---
# The read endpoint and share links reach files, not workspaces

The second half of the feature in this folder, after `1_tree.md`. With a
workspace a tree, what was built for one document is re-pointed at files:
the read endpoint and share links name a file, and the review gate gives
way to frontmatter. The factory reaching into a workspace waits for the
mirror (`../workspace-mirror.md`, a draft); an agent reaches a file through
the read endpoint meanwhile.

## Problem

Three things in `hosted-workspaces.md` and `sharable-links.md` assume one
document per workspace: `GET /w/{id}/plan.md`, a share link, and the review
state on the workspace with its author-cannot-approve rule.

## Approach

- **The read endpoint names a file**: `GET /w/{id}/{path}` behind the same
  per-workspace token, answering with that file's `meta.markdown`, and
  `GET /w/{id}/` listing the tree. The old `plan.md` path keeps answering
  for a workspace whose tree has one.
- **A share link names a file**, and the share page shows that file; the
  token is still per workspace, so one revocation kills every link into it.
  Per the human's answer in `sharable-links.md`, copy-out revokes links,
  and the viewer renders mermaid as the app does.
- **The review gate is retired.** `status:` in frontmatter and `approved` as
  the human's word say what the gate said, and they travel with the file.
  The server stops holding review state; the page head shows the status
  badge it shows for any file.

## Implementation guide

- [ ] `server/src/index.js` - `GET /w/:id/` and `GET /w/:id/*path`; share
      links carry a path; review routes removed
- [ ] `server/src/share.html` - render the named file; mermaid via one
      script tag
- [ ] `server/src/schema.js` + a migration - drop the review columns; share
      tokens gain a path
- [ ] `src/App.tsx` - the workspace page head loses the review buttons and
      gains the file's status badge; Share names the open file; copy-out
      revokes the workspace's links
- [ ] `e2e/workspace.spec.ts` - the read endpoint lists the tree and answers
      a path; a share link opens the named file; the old link shape still
      opens `plan.md`

## Out of scope

Roles beyond member, and the factory picking plans out of a workspace,
which needs the mirror.

## Open questions

- Does a share link into a folder make sense, showing the tree?
