---
"looped-plans": minor
---

The app is called Looped Plans. The wordmark in the rail, the window title and
the bundle's product name, the update banner and the "you are on the latest
version" notice, the settings hints, the dialog titles, the release-notes
heading, the README and the site all say the new name; the generated settings
schema says it too. The package is now `looped-plans`, so a changeset names it
that from here on.

What deliberately did not move: the bundle identifier and the updater endpoint,
which are how an installed copy finds its own updates, and the `plans` command
on your PATH. The macOS bundle is now `Looped Plans.app` — the installed shim
carries the app's name in its comment, so an existing one reads as stale and
Settings offers "Update" rather than claiming nothing is installed.
