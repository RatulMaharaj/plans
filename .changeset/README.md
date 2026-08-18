# Changesets

A changeset is a note about a change, written when the change is made rather
than reconstructed from `git log` at release time.

Run `pnpm changeset`, pick a bump level, and write a sentence. It lands here as
a markdown file, reviewed and merged alongside the code it describes.

`pnpm version` (which runs `changeset version`) consumes every file in this
folder: it bumps the version, syncs it into `src-tauri/`, and writes the notes
into `CHANGELOG.md`. From there they reach the GitHub release and the app's own
release-notes sheet.

See `plans/completed/5_changesets.md` for why, and `RELEASES.md` for the steps.
