---
"plans": patch
---

"Show all files" shows all folders too. The tree is built from the files a
walk returns, so a folder with nothing in it never appeared; in all-files
mode the app now asks the disk for the folders as well, on the same walk and
skip rules, and merges them in. Markdown mode keeps the tree to what has
files, as before.
