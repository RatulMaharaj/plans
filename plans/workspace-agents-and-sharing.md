---
status: draft
---
# Agents and share links reach files, not workspaces

The third of three plans, after `workspace-tree.md` and
`workspace-mirror.md`. With a workspace a tree on a branch, what was built
for one document is re-pointed at files: the factory picks plans out of it,
the read endpoint and share links name a file, and the review gate gives way
to frontmatter.

## Problem

Three things in `hosted-workspaces.md` and `sharable-links.md` assume one
document per workspace: `GET /w/{id}/plan.md`, a share link, and the review
state on the workspace with its author-cannot-approve rule. And nothing yet
lets an agent start work from a workspace.

## Approach

- **The factory dispatches from the mirror branch.** A plan in a workspace
  flipped to `ready` lands on the branch through the mirror; the factory's
  gate sees the flip on a push to that branch exactly as it does on any
  branch, and its `impl/` PR targets the mirror branch. The `busy` claim and
  the `done` flip come back through the mirror into the room. Nothing in the
  factory changes; what changes is that a workspace has a branch.
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
- [ ] `skills/plans/SKILL.md` - a paragraph on workspaces: a plan in one is
      a plan on its mirror branch, and the lifecycle is the same
- [ ] `e2e/workspace.spec.ts` - a plan flipped to `ready` in the room appears
      on the mirror; a share link opens the named file; the old link shape
      still opens `plan.md`

## Out of scope

Roles beyond member, and any notion of who may flip to `ready`: today that
is anyone in the room, which matches the repository it mirrors to.

## Open questions

- Should the factory's PR target the mirror branch or the default branch?
  Into the mirror branch keeps the argument in the room; into the default
  branch is what "the plan leaves the room" meant in the first plan.
- Does a share link into a folder make sense, showing the tree?
