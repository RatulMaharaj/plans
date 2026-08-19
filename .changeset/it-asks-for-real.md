---
"plans": patch
---

Deleting a file, discarding changes, forgetting a repository and removing a
frontmatter block all ask again — properly. They used `window.confirm`, which a
WKWebView swallows without showing anything, so "ask, then delete" had quietly
become "delete". They now put up a real native sheet whose button names the act:
Delete, Discard, Forget, Remove.
