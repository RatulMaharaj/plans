---
status: draft
---
# Improved Hotkeys

The draft asks for three things — chords like VS Code's `⌘K ⌘W`, a way to see
every shortcut, and customisation — and then argues against the first of them:
most writing here is done by agents, so a large built-in keymap would be effort
spent on the part of the app that gets used least.

That instinct is right, and it points at an order rather than a scope cut.
**The shortcut list and customisation are the same feature. Chords are a
separate one, and probably last.**

## The keymap and the command list are two lists of the same things

Commands already exist as data. `Palette.tsx:15` defines them:

```ts
export type Command = {
  id: string; group: string; label: string;
  value?: string; terms?: string; hint?: string;
  run: () => void;
};
```

Every command has an id, a group, a label, and an optional `hint` that is
already a rendered shortcut — `⌘S` is typed as a string at `Palette.tsx:112`.

The keymap is somewhere else entirely: one `else if` chain inside a `keydown`
listener (`App.tsx:1560-1652`), matching on `e.key` and modifiers by hand, with
a dependency array of twenty-odd entries. The two lists overlap heavily and
agree only because someone keeps them agreeing. `⌘S` appears as a string in the
palette and as `mod && e.key === "s"` in the chain, and nothing connects them.

So the interesting move is not "add more shortcuts". It is **make the command
registry the one place a shortcut is defined**, and derive both the keymap and
the list from it:

```ts
type Command = { /* … */ keys?: string };   // "mod+s", "mod+shift+o"
```

Once that holds:

- **The shortcut sheet is a view of the registry**, not a hand-written table
  that goes stale. This is the whole of `⌘?`.
- **Customisation is an override map** — `{ [commandId]: keys }` in settings,
  merged over the defaults, exactly as `loadSettings` already merges a stored
  blob over `DEFAULTS` (`settings.ts`). Keybinding packs, if they ever happen,
  are the same shape with a different source.
- The palette's `hint` stops being typed by hand and starts being rendered from
  the binding, so it cannot lie.

The draft's own conclusion — customisation may be a better answer than a large
built-in keymap — falls out of this for free rather than needing to be built
separately.

## What this costs, honestly

The chain in `App.tsx` is not merely a list of bindings; it is full of context.
`Escape` means different things depending on `zen` and `view`
(`App.tsx:1648-1651`), the palette swallows its own keys (`App.tsx:1564`), and
`⌘1/2/3` route through `goto` rather than a plain command. A table of
`keys → command id` cannot express "Escape, but only in zen".

That is the real work, and it is worth being explicit that it is not a
mechanical extraction: contextual keys either stay hand-written and live
outside the table, or the table grows a `when` clause and starts becoming VS
Code's keybinding system. **Start with the first.** Bindings that are
unconditional move to the registry; `Escape` and anything else that depends on
what is on screen stays where it is, and the sheet says so.

## Chords

`⌘K ⌘W` needs a pending-chord state, a timeout, and a visible indicator of a
half-typed chord — plus an answer for what happens when the first half collides
with an existing binding. None of that is hard; all of it is only worth doing
once there are enough commands that the single-keystroke space is genuinely
full.

It is not full. Defer, and revisit when the registry exists and the sheet shows
how much room is left.

## Vim keybindings are a different feature

A Neovim mode is not a keymap, it is a modal editing model inside the editor
surface — normal/insert/visual, operators, motions, counts. It belongs to
CodeMirror and Milkdown, not to the app's global `keydown` handler, and it
would arrive as an extension to those rather than as an entry in this registry.
Worth wanting; not worth conflating with this.

## Open questions

- Where does the sheet live — a modal like `NameSheet`, or a section of
  Settings? Settings already has a search box that filters controls, which is
  most of what a shortcut list wants.
- Should `⌘?` be the binding at all? It is `⌘/` on some layouts and needs
  `shift`, which is exactly the fiddliness this plan is meant to remove.
- Is a conflict between a custom binding and a built-in one an error, a
  warning, or last-one-wins?
- Does the registry need to cover editor-local keys (bold, italic) or only app
  keys? The palette only holds app commands today, so the sheet would be
  honestly incomplete on day one.

## Next

- [ ] `keys` on `Command`, with the existing unconditional bindings moved onto
      it and the chain in `App.tsx` reduced to a lookup
- [ ] Render `hint` from `keys` so the palette cannot disagree with reality
- [ ] The sheet: every command, grouped, from the registry
- [ ] Overrides in settings, merged the way settings already merge
- [ ] Decide whether contextual keys ever join the table, or stay hand-written
- [ ] Chords — only once the sheet shows the single-key space is full
