# Plans

A small desktop app for reading and editing the markdown in your local git
repositories — without opening the whole repo in an editor.

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
- **Files stay where you put them.** New file asks which repository and folder;
  rename is a path, so typing a folder into it moves the file, and its tab
  follows. A pasted or dropped image is written beside the document in
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

## Keys

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
- Settings live in `localStorage`, not a file on disk — so they are not
  inspectable or checked in, and clearing the app's data resets them.

