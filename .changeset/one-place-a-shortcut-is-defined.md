---
"plans": minor
---

Shortcuts now live in one registry instead of twice — once as a hand-written
`else if` chain and once as strings in the palette that agreed only because
someone kept them agreeing. The unconditional bindings moved into a keymap
table; the keydown handler is a lookup over it, and the palette renders its
key hints from it, so a hint can no longer lie about a key you have rebound.

⌘/ opens the new shortcut sheet: every binding, grouped, drawn from the
registry. Click one and press the new keys to rebind it — overrides merge
over the defaults in settings the way settings already merge, ⌫ unbinds, and
a conflict with another binding is refused by name rather than silently
letting one command win. Contextual keys — Escape, ⌘B while writing, ⌘+/− by
focus — stay hand-written, and the sheet says so instead of pretending.
