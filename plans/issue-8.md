---
status: busy
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
