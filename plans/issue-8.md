---
status: done
---
# Rename to Looped Plans

From [issue #8](https://github.com/loopedautomation/plans/issues/8).

> We should update the readme, and the app header, package.json etc and
> anything else relevant.

The app is called `Plans` everywhere a human can read it — the window title,
the header in the app, the README's first line, the marketing site, the
package name. The project now lives under `loopedautomation`, and the name
should say so: **Looped Plans**.

## What the rename touches

The product name reaches a reader through a handful of doors, and each one
has to be walked:

- **The app itself** — the Tauri window title and `productName`, the
  `<title>` of `index.html`, and whatever the header/rail renders as the
  app's own name.
- **The README** — the title and every sentence that names the app.
- **`package.json`** — the package `name`, which is the developer-facing
  handle for the same thing.
- **The site** — `site/index.html` is the public page; it carries the name in
  its title, headings and meta description.
- **Anywhere else the string is a name rather than a path** — the skills, the
  e2e tests that assert on the title, docs that introduce the app.

## What the rename must not touch

Some occurrences of "plans" are identity, not branding, and changing them
breaks shipped installs or repository plumbing:

- The bundle identifier and the updater endpoint — they key installed apps to
  their updates.
- The repository name, the `plans/` folder, branch prefixes, file paths, and
  every ordinary use of the word "plan" in prose about plan files.

The test is simple: if a reader sees it as the product's name, rename it; if
a machine resolves it, leave it.

## What was done

Every reader-facing "Plans" is now "Looped Plans": the rail wordmark, the
window title and `productName`, the update banner and the up-to-date notice,
the release-notes heading, the settings hints, the dialog title, the skill
command descriptions, the README, the site, `RELEASES.md`, the bundled skills,
and the generated settings schema (generator and both copies). `package.json`
is `looped-plans`, and `CHANGELOG.md`'s package heading follows it.

Left alone, deliberately: the bundle identifier `com.ratulmaharaj.plans`, the
updater endpoint, the settings-schema `$id`, `site/CNAME`, the download links
in the README and the site, the `plans` crate and binary, the `plans` CLI
shim, and the palette's `Plans` command group — that last one names the group
of plan commands, not the product.

Two of those are worth a human's attention rather than a rename: the identity
URLs still point at `RatulMaharaj/plans` and `plans.ratulmaharaj.com` while the
repository now lives under `loopedautomation`. Moving them is a release
decision, not a naming one — change the updater endpoint and every installed
copy looks somewhere new for its updates — so this change did not make it.

## Verification

The rename is string-level and was swept with grep rather than run: `pnpm` is
not on this machine and installs were not available, so `pnpm test`,
`tsc --noEmit`, `pnpm run schema:check` and `cargo fmt --check` could not be
executed here. Instead: the two generated schema copies were hand-edited to
exactly what the edited generator now emits and their diffs are identical, the
edited Rust line was kept under rustfmt's 100 columns, and a final sweep found
no reader-facing `Plans` left outside historical changelog entries.
