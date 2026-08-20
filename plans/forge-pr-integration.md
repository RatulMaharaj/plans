---
status: draft
---
# Forge Integration: Open PRs In The Palette And Git Panel

Seeded from `review-skill.md`, which declined it deliberately: the review
skill starts from a branch or PR number the human names in chat, because
listing open PRs is a real integration, not a detail of a skill.

The app's git layer is local — `api.ts` is status, diff, branches, push,
pull; there is no forge in it, and `GitPanel.tsx` has no notion of a PR.
Listing open PRs means `gh` or a forge API, auth, and a second identity to
manage.

What it would buy:

- Open PRs listed in the palette ("Review PR #42…") and in the git panel
- Handing a PR straight to the review skill with its number and base already
  known
- Possibly checking the branch out from the same gesture

Open questions:

- `gh` CLI (already authenticated, GitHub-only) versus forge APIs (broader,
  auth to build)?
- Where does the identity live, and what happens on machines without one?
