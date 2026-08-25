---
"plans": minor
---

Long dropdowns can be searched. Past ten choices a menu gains a filter row
scored by the palette's own subsequence matcher, so `settings` finds
`plans/settings-json` in a list where every name begins `plans/` — the prefix
type-ahead a select taught everyone stays the right thing below that. No call
site opts in: the branch picker, the folder pickers, the chat list and an
agent's model list all inherit it from `Dropdown` itself.

The branch list behind it grew up to match: branches that exist only on a
remote are offered too, set apart under a rule, with checking one out creating
the tracking branch; the list is ordered by recency rather than alphabetically;
and the menu shows the branches it already had, saying it is refreshing, rather
than an empty box while git takes its three seconds.
