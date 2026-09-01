---
"plans": patch
---

A new file's name keeps the case you typed: "Meeting Notes" becomes
`Meeting-Notes.md`, not `meeting-notes.md`. The `{slug}` token lowercased the
title, so the filename silently disagreed with what was in the sheet.
