---
"plans": minor
---

A plan's `model:` and `effort:` frontmatter keys — the ones that route a
dispatched implementation run — can be set from the palette, offering exactly
what the live agent session advertises (ACP `model` and `thought_level`
options) and nothing when no session is advertising: the vocabulary is the
agent's, never the app's. The plans skill documents the keys, and the bundled
dispatchers treat a value they don't recognise as absent — warn and fall back
to the default — rather than failing the run over a typo.
