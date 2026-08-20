---
"plans": patch
---

Fixes a file growing a second, empty frontmatter block in front of its real
one — `---`, blank, `---`, then the actual metadata. Only the first block
parses as frontmatter, so the plan's status became invisible to the app while
the file still looked almost right on disk.

Emptying the frontmatter sheet's textarea hands back an empty string, and an
empty string is not the same thing as no frontmatter: `null` means the file has
no block, `""` means the block is there and holds nothing. The join treated
only the first as "write nothing", so the second wrote a bare pair of fences.
A block holding nothing is now no block at all, checked before the
write-it-back-verbatim path so that a file already carrying an empty block is
repaired by saving it rather than having it preserved.
