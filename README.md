# Plans

A small desktop app for editing the `plans/` folder of your local git repositories —
without opening the whole repo.

Write plans with Claude Code, edit them in a WYSIWYG markdown editor, then stage,
commit, and push from the built-in git panel.

## What it does

- **Multiple repos.** Add any local git repository; the app remembers them between launches.
- **Plans only.** On open it scans up to four levels deep for plans-like folders
  (`plans`, `plan`, `*-plans`, `*_plans` — so `plans/`, `docs/plans/`, `.claude/plans/`
  all get picked up) and shows only the markdown inside them. Repos with more than
  one such folder get per-folder toggles.
- **WYSIWYG editing.** [Milkdown Crepe](https://milkdown.dev) renders the document
  as rich text while the file on disk stays plain, diff-friendly markdown.
  Autosaves ~700ms after you stop typing; `Cmd/Ctrl+S` forces a save.
- **Full git panel.** Branch switcher, pull/push with ahead/behind counts, per-file
  diffs, stage/unstage individually or all at once, and commit
  (`Cmd/Ctrl+Enter` in the message box).
- **Three papers.** Day, Sepia, and Night, in the manner of an e-reader. Colour
  discipline throughout: chrome is ink at varying opacity, and the only
  chromatic values in the app are the three git states — so colour always means
  "this differs from what's committed."
- **Five typefaces.** Open-source families from
  [Open Foundry](https://open-foundry.com): Vollkorn (Friedrich Althausen),
  Libre Baskerville (Impallari Type), Work Sans (Wei Huang), Karla
  (Jonny Pinhorn), Space Mono (Colophon Foundry). All SIL OFL, vendored into
  `src/fonts/` so the app needs no network; re-fetch with `pnpm fonts`.
  Size, line length, and line height are adjustable alongside them.
- **Live changes view.** `⌘D` diffs the plan against its last commit and updates
  as you type — it compares the editor buffer, not the file on disk. Rendered
  with [@pierre/diffs](https://diffs.com), unified or side by side.
- **Settings page.** `⌘,` — paper, typeface, measure, spellcheck, diff layout
  and line numbers and wrapping, panel visibility, watch interval, and the
  repository list, all in one place.
- **Picks up outside edits.** The file list and git status re-poll every 4s, so
  plans written by Claude Code in a terminal appear without a restart.

Git operations shell out to your system `git`, so your existing credentials,
SSH keys, commit signing, and hooks all apply.

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

| Path                                      | What lives there                                 |
| ----------------------------------------- | ------------------------------------------------ |
| `src-tauri/src/lib.rs`                    | All Rust commands: repo discovery, file I/O, git |
| `src/api.ts`                              | Typed wrapper over the Rust commands             |
| `src/App.tsx`                             | Layout, repo/file state, autosave                |
| `src/Editor.tsx`                          | Milkdown Crepe editor instance                   |
| `src/GitPanel.tsx`                        | Status, diffs, staging, commit, push/pull        |
| `src/fonts.ts`, `scripts/fetch-fonts.mjs` | Typeface registry and the vendoring script       |

## Notes

- File paths from the UI are resolved inside the selected repository only;
  `..` and absolute paths are rejected in the Rust layer.
- Removing a repo (right-click its chip) only forgets it in the app — nothing on
  disk is touched. Deleting a plan does remove the file.
- `Pull` uses `--ff-only`, so a diverged branch fails loudly instead of
  auto-merging behind your back.

