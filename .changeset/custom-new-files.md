---
"plans": minor
---

A new file is whatever you say it is. There used to be exactly one shape — a
title, `status:` frontmatter, a heading — and it was built in Rust, so adding
a daily note meant changing the backend.

The shape now comes from a template, and a template is a markdown file: its
frontmatter is its configuration, its body is the body of the file it stamps
out. They live in `~/.plans/templates/`, beside the skills, with the ownership
the other way round — the skills are the app's and are rewritten on every
launch; the templates are yours, seeded once and only read after that, so
editing or deleting one sticks.

Two ship: `plan.md`, which writes exactly what ⌘N always wrote, and
`daily-note.md`, a blank file named for today. A template says what it is
called (`name`), what its file is called (`fileName`, with `{slug}`,
`{title}` and `{date:yyyy-MM-dd}` in it), and what frontmatter the new file
starts with (`frontmatter:`, where `{firstStatus}` is the first word of your
status vocabulary). A pattern that never mentions the title needs no title, so
"New: Daily Note" is one keystroke and no sheet — and asking for today's note
when today's note is already there opens it rather than refusing.

The palette carries one "New: …" command per template, ⌘N stays bound to the
first, and the tree's "New file here" opens into the list when there is more
than one. Settings names the folder and opens it; the configuration is in the
files, not in `settings.json`.

Underneath, `create_plan` is now `create_file`: it refuses to overwrite and
writes the bytes it is handed, and knows nothing about what a plan looks like.
