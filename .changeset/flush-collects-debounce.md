---
"plans": patch
---

A flush now collects the keystrokes still inside the editor's typing
debounce. Changes were reported on a pause (~180ms), so a save that ran
sooner — ⌘S right after typing, or the rewrite seed flushing before it
quotes the file to the agent — saw an empty buffer, called the file saved,
and the rewrite went out quoting text that was not on disk yet.
