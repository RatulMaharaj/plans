---
status: active
---
# View Mode Per Buffer

Write, source, and diff are one app-wide switch: `useState<View>("write")` at
`App.tsx:158`. Flip a file to source, click another tab, and the mode follows
you. The mode belongs to the buffer, and the three buttons belong in the tab
row where the buffers live — today they sit in `.page-head`
(`App.tsx:1903-1925`) as if they were page furniture.

## The obstacle is that `view` is also the settings router

`type View = "write" | "source" | "diff" | "settings"` (`App.tsx:108`). The
same state that says how to render the buffer also says whether you are on the
settings page, and roughly twenty call sites check it — `App.tsx:993, 1600,
1618, 1631, 1644, 1647, 1650-1651, 1768, 1793, 1887, 1906, 1912, 1919, 1997,
2037, 2046, 2048, 2064, 2070, 2098, 2243`. A per-buffer mode cannot hold
`"settings"`, so the split comes first and is most of the work.

**Step one, no behaviour change:** a separate `settingsOpen` boolean. `view`
shrinks to `"write" | "source" | "diff"`. Every `view === "settings"` becomes
`settingsOpen`; `openFile`'s `setView(v => v === "settings" ? "write" : v)`
at `App.tsx:993` becomes `setSettingsOpen(false)` — the buffer keeps whatever
mode it had. Land this alone.

## Step two: the mode moves onto the tab

`Tab` (`App.tsx:54`) grows an optional field:

```ts
type Tab = { repo: string; path: string; view?: "write" | "source" | "diff" };
```

Tabs already persist to localStorage under `plans.tabs.v1` (`App.tsx:49`,
written at `469-470`, read at `177`), so remembered-per-file modes across
restarts fall out for free. Absent means `"write"`, which also covers every
tab already stored.

The active mode becomes a derivation, not state:
`const view = activeTab?.view ?? "write"`.

- `goto()` (`App.tsx:866-879`) becomes a per-tab setter — map over `tabs`,
  set `view` on the active one — keeping its "only rebuild Milkdown if the
  source text changed" logic. Its `sourceOnEntry` ref (`App.tsx:865`) is a
  singleton; with per-buffer modes either key it by `${repo}::${path}` or
  reset it in `openFile`, whichever the diff makes cleaner.
- ⌘1/2/3 (`App.tsx:1618`) and ⌘D (`App.tsx:1644`) route through the new
  setter.
- The git panel's `openFile(...).then(() => setView("diff"))` at
  `App.tsx:2098` sets the mode for a buffer other than the one active at call
  time — it should open the tab *with* `view: "diff"` instead.

## Step three: the buttons move up

The tab row is `<div className="tabs" role="tablist">` at `App.tsx:1847-1878`,
a scrolling flex row (`App.css:1562-1572`). The segmented control must not
scroll away with the tabs: wrap the row so `.tabs` gets
`flex: 1 1 auto; overflow-x: auto` and the control sits after it,
`flex: 0 0 auto`, pinned right.

Stays behind in `.page-head`: the diff Unified/Split toggle
(`App.tsx:1887-1901`), which reads `settings.diffStyle` and is genuinely a
global preference, and the frontmatter badges (`App.tsx:1927+`).

One loss to accept: the tab row is hidden in zen mode (`App.tsx:1847`), so zen
has no visible view switch. ⌘1/2/3 and ⌘D still work there, which is in the
spirit of zen anyway.

## Done when

- Two open files hold different modes; switching tabs switches the mode with
  them, and it survives a restart.
- Opening a file from the git panel lands in diff without disturbing the
  previously active buffer's mode.
- Settings opens and closes without touching any buffer's mode.
- The buttons live at the right edge of the tab row and stay put while the
  tabs scroll.
- Old stored tabs (no `view` field) open in write.
