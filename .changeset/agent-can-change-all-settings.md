---
"plans": minor
---

The agent in the chat can change any setting. A new bundled skill tells it
where `settings.json` lives on each platform, to read the generated schema
before writing rather than guessing keys, and the etiquette of writing the
file back: one write, keep `$schema`, keep the keys this build does not know,
leave the app-managed ones alone. It installs with the other skills. The
settings poll no longer shares `watchSeconds` with the document watcher, so
someone who has turned repository watching off still sees the change land -
that knob was the one way the settings file could wedge itself shut.
