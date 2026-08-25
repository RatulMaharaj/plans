---
"plans": minor
---

Settings live in a file. `settings.json` in the platform's config directory is
now where every setting on the Settings page actually lives, with a
`settings.schema.json` generated from the app's own `Settings` type written
beside it — so an editor completes this build's keys and shows the same prose
the settings page argues in. localStorage stays on as a warm start, so the
theme is still right on the first frame; the file wins any disagreement, and
first launch migrates whatever was already stored. Edits made outside are
picked up on the same interval as everything else read from disk, which is also
how the agent in the chat panel can change your settings with no new tool
surface at all — it edits a file. A file that does not parse keeps the last
good settings and says so rather than resetting anything. "Open settings file
(JSON)" is on the Settings page, next to the path, and in the palette.
