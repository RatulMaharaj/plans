---
"plans": patch
---

Six from the open bug list:

- Long paths in the git panel no longer push the filename out of view — the
  name never gives way; the folder path is what truncates, from the front, so
  the nearest folder survives.
- "Refresh branches" in the git commands re-reads the branch list on demand.
- Right-click a repository in the tree → "Open in Terminal".
- Links between markdown documents work: ⌘-click a relative link and the
  other file opens in the app; anything with a scheme opens in the browser.
  A plain click stays an editing click, and the webview never navigates away.
- Escape stops the agent mid-answer, matching the Stop button.
- Long documents show a thin scrollbar in the paper's own colours, and the
  scroll position is remembered per buffer — jumping between two documents no
  longer resets both to the top.
