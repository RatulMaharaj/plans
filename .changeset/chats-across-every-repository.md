---
"plans": patch
---

`#` in the palette can now reach every open repository's conversations, not only
the one you are in. It is a setting rather than a change: the list following the
focused repository is the list being right for most work, so that stays the
default, and "every repository" is there for the other habit — one train of
thought that outlives which window happens to be focused.

A foreign chat is labelled with the repository it belongs to, since chat titles
come from what was said and two repositories can easily hold one called the same
thing. Opening it goes there: a transcript is keyed by its repository, the agent
runs in it, and the plans it is about are there, so the window follows.

Reading the list leaves nothing behind. The index-loading the panel does invents
and writes an empty conversation when a repository has none, which is right for
the repository being worked in and would otherwise seed a stray "New chat" in
every repository you have ever opened.
