<div align="center">

<img src="site/icon.png" width="72" alt="" />

# Looped Plans

**A small desktop app for reading and editing the markdown in your local git
repositories** — without opening the whole repo in an editor.

<sub>

**[Download for macOS](https://github.com/loopedautomation/plans/releases/latest)** · free and open source

</sub>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/plans-night.png" />
  <img src="site/plans-day.png" width="760" alt="The Looped Plans window: a file tree of markdown across repositories on the left, the open document rendered as a page on the right, with the file edited since the last commit marked in the tree." />
</picture>

</div>

The files it shows are usually written by something else: Claude Code in a
terminal, an agent, a script. So the app is built to be a good way to *live
with* that output — read it, review the diff, adjust it, commit it — rather
than a general-purpose markdown editor.

## What it does

- **Every markdown file, in every open repo.** Add any local git repository;
  the app remembers them between launches and shows them all at once, at the top
  level of one tree. `.git`, `node_modules`, `target` and the usual build
  directories are skipped, and gitignored files are hidden until you ask for
  them.
- **Nothing is locked, and nothing is lost.** The file on disk is the only
  buffer. Every save is conditional on a fingerprint taken when the file was
  read: if something else wrote it first the write is refused, your edit is kept,
  and you are asked whether to keep yours or take theirs. A file that changes
  while you have it open and clean simply reloads.
- **Autosave on your terms.** After a pause (2s by default, adjustable), when the
  window loses focus, or only on `⌘S`. Switching files or quitting always
  flushes what is pending.
- **Three ways to look at a file.** `⌘1` the page, `⌘2` the raw markdown, `⌘3`
  the diff against the last commit. All three are editable and all three are the
  same buffer, so a change in one is a change in the others.
- **WYSIWYG that keeps the file intact.** [Milkdown Crepe](https://milkdown.dev)
  renders the document as rich text while the file stays plain markdown.
  The round trip is byte-for-byte: bullets stay `-`, text is not escaped, and the
  trailing newline and frontmatter block are preserved exactly. Opening a file
  does not count as editing it.
- **The HTML in your markdown renders.** Local images are read from the
  repository, `<picture>` picks its source from the paper you are using rather
  than from the system appearance, and wrapper tags like `<div align="center">`
  or `<sub>` do what they say. Double-click any of it to edit the source.
  Comments become a margin note. Mermaid blocks draw a diagram under their source.
- **Full git panel.** Branch switcher, pull/push with ahead/behind counts,
  per-file diffs, stage/unstage, undo a change, and commit (`⌘⏎` in the message
  box). It acts on markdown only, and says how much else in the repo it is
  leaving alone.
- **Command palette.** `⌘P` for files across every open repo, `⌘⇧P` for commands
  — every setting, and git: branch, pull, push, fetch, commit, switch — and
  `?` to search *inside* files, which is the question notes usually pose.
- **New files come from templates you own.** A template is a markdown file in
  `~/.plans/templates/`: its frontmatter says what it is called, what to call
  the file (`{slug}`, `{title}`, `{date:yyyy-MM-dd}`) and what frontmatter to
  start it with; its body is the body. Two ship — a plan and a blank daily note
  named for today — and the folder is yours after that, so editing or deleting
  one sticks. The palette carries a "New: …" per template, `⌘N` is the first,
  and a filename the calendar answers skips the naming sheet entirely.
- **Files stay where you put them.** New file asks which repository and folder;
  renaming edits the name, moving picks a folder — two questions, two answers,
  and a tab that follows its file through either. Dragging a file or a folder
  onto another folder moves it. A pasted or dropped image is written beside the document in
  `assets/` and linked relatively, never inlined as a data URL.
- **Three papers.** Day, Sepia, and Night, in the manner of an e-reader. Colour
  discipline throughout: chrome is ink at varying opacity, and colour means "this
  differs from what's committed" — with two deliberate exceptions, code blocks
  and diffs, where hue is doing real work. Each paper carries its own syntax
  palette.
- **Five typefaces**, plus five monospaced faces for the chrome and code.
  Open-source families from [Open Foundry](https://open-foundry.com): Vollkorn
  (Friedrich Althausen), Libre Baskerville (Impallari Type), Work Sans (Wei
  Huang), Karla (Jonny Pinhorn), Space Mono (Colophon Foundry). All SIL OFL,
  vendored into `src/fonts/` so the app needs no network; re-fetch with
  `pnpm fonts`.
- **Picks up outside edits.** File lists and git status re-poll every 4s, and the
  open file is watched separately, so work done in a terminal turns up without a
  restart.

Git operations shell out to your system `git`, so your existing credentials,
SSH keys, commit signing, and hooks all apply.

## Hotkeys

| Key            | What                                                            |
| -------------- | --------------------------------------------------------------- |
| `⌘P` / `⌘⇧P`   | Find a file · all commands                                      |
| `⌘1` `⌘2` `⌘3` | Page · source · diff                                            |
| `⌘N` / `⌘⇧O`   | New file · add a repository                                     |
| `⌘S`           | Save now                                                        |
| `⌘W`           | Close the buffer                                                |
| `⌘⌥←` `⌘⌥→`    | Previous · next buffer                                          |
| `⌘B`           | Show or hide the tree (`⌘⌃B` while writing, where `⌘B` is bold) |
| `⌘G`           | Git panel                                                       |
| `⌘⇧L`          | Zen — the page alone                                            |
| `⌘+` `⌘−`      | Text size, or tree size when the tree has focus                 |
| `⌘,`           | Settings                                                        |

## Tests

```sh
pnpm test          # behaviour and performance, in a real browser
pnpm test:ui       # the same, watchable
cd src-tauri && cargo test
```

`tauri-driver` has no macOS support, so the packaged app cannot be driven.
It matters less than it sounds: every failure this project has had lived in the
frontend or at the IPC boundary, and `e2e/fake-backend.ts` answers every Rust
command in memory — so a test can rewrite a file mid-edit to provoke a conflict,
or assert exactly which writes the app issued.

`e2e/perf.spec.ts` holds budgets rather than benchmarks. Every slowdown here has
been a regression — a hidden editor reparsing on each keystroke, a plugin
dispatching from its own update hook, four repositories walked at once behind
someone's typing — invisible until measured. The budgets fail when a change
makes the app worse and stay quiet otherwise.

## Releasing

Every change carries its own note, written when the change is made:

```sh
pnpm changeset     # a bump level and a sentence, committed with the change
pnpm run version   # collects them: bumps every version, writes CHANGELOG.md
```

Cutting a release is then a tag. The build signs, notarizes, and attaches both
the `.dmg` and the updater's `.app.tar.gz` to a **draft** release; publishing it
is what makes an installed copy see it. Installed copies check GitHub on their
own and offer the update in a banner — never a modal, and never without a press.
[`RELEASES.md`](RELEASES.md) has the whole routine.

## Requirements

- [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io)
- [Rust](https://rust-lang.org) (stable)
- `git` on your `PATH`

## Running

```sh
pnpm install
pnpm app         # dev mode with hot reload
pnpm app:build   # produces a bundled .app / installer under src-tauri/target/release/bundle
```

## Layout

| Path                                      | What lives there                                                   |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `src-tauri/src/lib.rs`                    | All Rust commands: repo discovery, file I/O with fingerprints, git |
| `src/api.ts`                              | Typed wrapper over the Rust commands                               |
| `src/App.tsx`                             | Layout, repo and buffer state, autosave, conflict handling         |
| `src/FileTree.tsx`                        | The tree, its git marks and its context menus                      |
| `src/Editor.tsx`                          | Milkdown Crepe instance and its serialiser settings                |
| `src/SourceView.tsx`                      | The raw markdown, as CodeMirror                                    |
| `src/DiffView.tsx`                        | The editable diff against `HEAD`                                   |
| `src/GitPanel.tsx`                        | Status, staging, undo, commit, push/pull                           |
| `src/Palette.tsx`                         | Files and commands behind `⌘P`                                     |
| `src/html-view.ts`                        | Rendering and editing the HTML inside markdown                     |
| `src/mermaid-view.ts`                     | Diagrams drawn under their source                                  |
| `src/code-theme.ts`                       | Syntax highlighting, in the current paper's ink                    |
| `src/matter.ts`                           | Splitting and rejoining frontmatter, losslessly                    |
| `src/settings.ts`                         | Every setting, its range, and how it is applied                    |
| `src/update.ts`                           | Checking the feed, downloading, and relaunching into the new one   |
| `scripts/sync-version.mjs`                | One version across four files, and the bundled release notes       |
| `scripts/settings-schema.mjs`             | The settings JSON Schema, generated from the `Settings` type       |
| `src/fonts.ts`, `scripts/fetch-fonts.mjs` | Typeface registry and the vendoring script                         |

## Notes

- File paths from the UI are resolved inside the selected repository only; `..`
  and absolute paths are rejected in the Rust layer.
- HTML is sanitised before rendering — no scripts, no frames, no event handlers.
  These files are written by agents, and opening one should never run anything.
- Forgetting a repository removes it from the app only; nothing on disk is
  touched. Deleting a file does delete it.
- `Pull` uses `--ff-only`, so a diverged branch fails loudly instead of
  auto-merging behind your back.
- Settings live in `settings.json` in the platform's config directory, with a
  generated `settings.schema.json` beside it. Open it from Settings or the
  palette; edits made outside are picked up on the watch interval, and a file
  that does not parse keeps the last good settings rather than resetting them.
  `localStorage` still holds a copy, but only as a warm start for the first
  frame — the file is what counts.

