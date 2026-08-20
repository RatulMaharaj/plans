---
"plans": patch
---

A new plan is created with `status:` frontmatter already in it, using the first
word of your configured status vocabulary.

Until a plan has a status it is invisible to everything that reads one — the
tinted dot in the tree, the status filter, and now the ordering — so a file made
in the app did not look like a plan to the app until somebody remembered to say
so. Writing it at creation means it is a plan from its first save.

The word comes from settings rather than being baked in, because the vocabulary
is a convention the repository keeps rather than one the app owns.
