# Changesets and Release Notes

Releases have no memory. The version is hand-edited into `package.json` and
`src-tauri/tauri.conf.json` — two fields, one of which Tauri actually bundles,
and a third in `src-tauri/Cargo.toml` that `RELEASES.md` does not even
mention. The release body is then written from scratch at publish time, out of
whatever the tag range happens to contain and whatever the author remembers.

The goal: every change carries its own note, written when the change is made;
cutting a release collects those notes, bumps every version in one motion, and
hands the result to the GitHub release, to `CHANGELOG.md`, and to the app
itself.

This is one half of the release pipeline. The other half is
[`auto-updates.md`](./auto-updates.md): changesets produce the notes and the
version bump, the updater ships them and opens them on first launch.

## Approach

Use `@changesets/cli` rather than a hand-rolled convention. It is a small
dependency for a single-package repo, but the thing it gets right is the part
that is easy to get wrong by hand: the note is a file, written alongside the
change, reviewed with the change, and merged with the change. A script that
reads `git log` at release time is reconstructing intent after the fact, which
is exactly when nobody remembers it.

```sh
pnpm add -D @changesets/cli
pnpm changeset init
```

`.changeset/config.json` needs one non-default setting:

```json
{ "privatePackages": { "version": true, "tag": false } }
```

The package is `"private": true`, and without that flag changesets ignores it
entirely — `changeset version` runs, reports success, and changes nothing.
`tag: false` because the tag is pushed by hand as the release trigger
(`RELEASES.md`), not by changesets.

A changeset is a markdown file with a bump level and a sentence:

```markdown
---
"plans": minor
---

Drag files and folders into folders.
```

The plans in this folder are AI-written, and so are most of the changes they
describe; a changeset per change is a natural artifact of the same pass rather
than a new piece of process to remember.

## The version-sync problem

Changesets only knows about `package.json`. Plans has the same version in
three places, and a bundle labelled with the previous version is the kind of
mistake that is invisible until a user reports it.

`scripts/sync-version.mjs`, alongside the existing `release-linker.mjs` and
`fetch-fonts.mjs`, reads the version from `package.json` and writes it to:

- `src-tauri/tauri.conf.json` — the `version` field, which is what Tauri puts
  in the bundle and what the updater compares against
- `src-tauri/Cargo.toml` — `package.version`, then `cargo update -p plans` so
  `Cargo.lock` moves with it

Wired as the `version` lifecycle script so `changeset version` runs it
automatically:

```json
"version": "changeset version && node scripts/sync-version.mjs"
```

And enforced, not just automated. A `--check` mode of the same script, run in
`ci.yml`, fails when the three disagree. Automation that can be bypassed by
editing one file by hand is not a guarantee; the check is.

## Where the notes go

`changeset version` writes `CHANGELOG.md` at the repo root — one source, three
destinations:

- **The repository.** `CHANGELOG.md`, committed with the version bump.
- **The GitHub release.** `tauri-action` takes a `releaseBody`; a small step in
  `release.yml` slices the section for the version being tagged out of
  `CHANGELOG.md` and passes it in. The draft release arrives with its notes
  already written, so the publish step in `RELEASES.md` becomes a read rather
  than a writing task.
- **The app.** A build step emits the current version's section as an asset the
  frontend can import — `src/release-notes.ts` generated at build time, or a
  file under `public/`.

The third is the one that makes "release notes open automatically" possible.
Reading them from the bundle rather than fetching them means the sheet opens
offline, opens instantly, and opens for someone who installed a `.dmg` by hand
and never touches the updater.

## Showing them in the app

A notes sheet in the overlay idiom the app already has — a `.matter-scrim` /
`.matter-sheet` pair (`App.css:1318`) rendered from the JSX tail of `App.tsx`
off a nullable piece of state, the same shape as `TextPrompt.tsx` and
`NameSheet.tsx`. The body is markdown, rendered through the path the app
already owns for rendering markdown.

It opens on two triggers:

- **Automatically**, once, when the running version is newer than a
  `lastSeenVersion` remembered in `settings.ts` (`plans.settings.v1`, merged
  over `DEFAULTS`, so an older stored settings blob just reads as "never seen"
  and shows the notes once). Compare against `getVersion()` from
  `@tauri-apps/api/app` rather than trusting the note asset to describe the
  running binary.
- **On demand**, from a *Release notes* command in `Palette.tsx:101`, in the
  same group as the other app-level commands.

Never blocking, always dismissable, and shown exactly once. A changelog that
interrupts twice is a changelog people learn to dismiss unread, and then the
one release where it mattered goes unread too.

No tag has been cut yet and there is no `CHANGELOG.md`, so `0.1.0` is a clean
starting point — there is no history to backfill and no existing release body
to reconcile.

## Open questions

- Should the in-app notes be the raw `CHANGELOG.md` section, or a separate
  hand-written "what's new" aimed at a reader rather than a reviewer? The raw
  section is free and always accurate; it is also full of entries that mean
  nothing to someone who does not read the diffs. Possibly a `Highlights`
  heading convention within the changeset itself.
- Is per-change ceremony worth it for a single-package private repo, or would
  a thin script over commit messages do? The argument for changesets is the
  bump level — deciding patch versus minor at write time, per change, rather
  than guessing once per release.
- The `version` script assumes `changeset version` runs locally before the tag
  is pushed. That is a step `RELEASES.md` does not currently describe, and
  `RELEASES.md` needs updating either way.
- Does the generated `src/release-notes.ts` belong in the repo or in
  `.gitignore`? Committed, it is a diff on every release; ignored, `pnpm build`
  becomes a prerequisite for `tsc --noEmit` in `ci.yml`.

## Next

- [ ] `pnpm add -D @changesets/cli`, `changeset init`, set `privatePackages`
- [ ] `scripts/sync-version.mjs` with a `--check` mode
- [ ] Wire the `version` script; add the check to `ci.yml`
- [ ] Write a changeset for the current unreleased work and dry-run `changeset version`
- [ ] Slice `CHANGELOG.md` into `releaseBody` in `release.yml`
- [ ] Emit the current version's section as a bundled asset at build time
- [ ] Release notes sheet, plus the `Palette.tsx` command
- [ ] `lastSeenVersion` in `settings.ts` and the open-once-on-launch check
- [ ] Update `RELEASES.md`: `changeset version` replaces "bump the version in both"
- [ ] <br />
