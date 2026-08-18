---
"plans": patch
---

Empty folders deleted outside the app no longer haunt the sidebar. They live
only in the app's own memory, and that memory now checks the disk on every
refresh instead of assuming a folder it once made is a folder that still
exists.
