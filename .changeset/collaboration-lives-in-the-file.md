---
"plans": minor
---

Collaboration, without accounts. Comments are markdown-native HTML comments:
right-click or ⌘⇧M writes one after the paragraph, signed with whatever
`git config user.name` says. A comment with several `@name:` lines renders as
a thread, and the card grows a reply field that appends one more line to the
file. The frontmatter gets read as well as edited: `status:` shows as a badge
in the header and a tinted dot on the tree row, `owner:` and `due:` in the
header — read-only, from a few conventional keys the app recognises but does
not own.
