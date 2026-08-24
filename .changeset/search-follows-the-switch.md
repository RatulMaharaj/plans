---
"plans": patch
---

Search follows the "all files" switch, and the git panel stops filtering.
The palette's footer carries the search scope — markdown by default, one
click for every file — and both searches obey it: file names and the `*`
search inside files. The git panel now always reports the whole repository:
every changed file is listed, stageable, and openable in the diff view,
whatever the tree shows. The source of any file is editable as typed: the
frontmatter splitter no longer peels a `---` header off a non-markdown file
mid-edit. Settings commands in the palette keep fixed names — "All files",
"Finished plans", "Chat position" — with the current state in the value
chip, instead of labels that flip between show and hide. And the diff view
got faster where it counts: the heavy backend commands moved off the main
IPC thread so "Reading the committed version" no longer waits behind a
repository walk, and a git action refreshes the diff in place instead of
blanking it while the committed side is re-read. Clicking through the git
panel is instant now, twice over: the file opens straight into Diff instead
of mounting the writing surface first and tearing it down, and the committed
side of every changed file is prefetched as soon as the panel's list is
known, so the diff paints from cache and revalidates behind it. That work
also surfaced a real bug: switching between changed files could pair one
file's committed side with another's working copy under a stale highlight
cache key, leaving the diff showing the previous file — or nothing. The diff
view is now keyed per document and its cache keys carry a content
fingerprint, and a regression test clicks down a panel of changed files
asserting each diff is its own and paints within budget.
