---
status: active
---
# Formatters Support

Plans writes markdown back to disk with its own remark-stringify settings. Every
repo that already runs a formatter has its own opinion about that markdown, so
the two disagree and saving a file produces a diff nobody asked for.

The goal: when a repo has a formatter, Plans defers to it. A file Plans saves
should be byte-identical to what `prettier --write` (or the repo's equivalent)
would produce, so the app never shows up in a diff review.

## Approach

Shell out to the repo's own formatter rather than reimplementing its style.
Matching Prettier's markdown printer by hand is a losing game — wrap width,
table alignment, list renumbering, escaping rules — and the moment the repo
bumps its formatter version we are wrong again. Running the real binary is the
only way to be exactly right.

The pipeline on save becomes:

- Serialize the editor doc to markdown (unchanged, `Editor.tsx:165`)
- Re-attach frontmatter (unchanged, `assemble()` in `App.tsx:489`)
- **Format the resulting text through the repo's formatter**
- Write the formatted text via `write_plan` (`lib.rs:372`)

Formatting happens on the full assembled text, before the write, so the stamp
returned by `write_plan` matches what is actually on disk and the existing
optimistic-concurrency check keeps working.

## The minimal-diff constraint

Non-negotiable: opening a file and saving it without edits must produce a zero
line `git diff`. Shelling out to a formatter threatens this in one specific
case — a repo that *has* a formatter config but whose markdown files were never
actually formatted. There, the first save would reformat the whole document and
bury the user's one-line edit in a hundred-line diff.

The guard is a **check-first rule**, decided once per file when it is opened:

- Run the formatter in check mode against the file's on-disk contents
- If the file is already formatter-clean, mark it *managed* — format on every
  save from now on
- If the file is dirty, mark it *unmanaged* — never format it, just write our
  own serialization as we do today

This makes the feature strictly diff-reducing. It can only ever bring our output
closer to what the repo already looks like, never introduce churn. The check is
cheap enough to run on open and cache for the session.

Worth surfacing the unmanaged case in the UI — a quiet indicator plus a "format
this file" action — so a user who *wants* the reformat can opt into it
deliberately, as one commit, rather than having it happen to them.

## Detection

Detection runs once per repo on `open_repo` and is cached. Look for, in order:

- `.prettierrc`, `.prettierrc.{json,yml,yaml,js,cjs,mjs,toml}`, `prettier.config.*`,
  or a `prettier` key in `package.json`
- `dprint.json` / `.dprint.json`
- `.markdownlint*` with `--fix` capability
- `.editorconfig` as a weak fallback signal

Then resolve a runnable binary, preferring repo-local over global:

- `node_modules/.bin/prettier` relative to the config's directory, walking up
- The package manager's runner (`pnpm exec`, `yarn`, `npx --no-install`)
- A binary on `PATH`

If a config exists but no binary resolves, treat the repo as having no formatter
and say so in settings rather than failing saves.

Note this is per-file, not just per-repo: monorepos have different configs in
different packages, and Prettier's own resolution walks up from the file being
formatted. Resolving from the file's directory rather than the repo root gets
this right for free.

## Security

Running `node_modules/.bin/prettier` from a repo the user opened is arbitrary
code execution with the app's privileges. Opening a plans folder should not be
the same act as running its code.

- Formatter execution is **off by default** and enabled per-repo, with a prompt
  naming the exact resolved binary path on first detection
- The decision is remembered per repo path; a changed binary path re-prompts
- Never run an installer — `npx --no-install` only, never plain `npx`
- Spawn with no shell, an explicit argv, the repo as cwd, and a timeout

## Rust side

New commands in `lib.rs`, alongside the existing set:

- `detect_formatter(repo, rel_path) -> Option<FormatterInfo>` — config kind,
  resolved binary path, version string
- `format_markdown(repo, rel_path, content) -> FormatResult` — stdin/stdout
  through the binary with `--stdin-filepath` so the formatter applies its own
  markdown rules and config resolution; returns formatted text, or unchanged
  text plus a diagnostic on failure
- `check_formatted(repo, rel_path) -> bool` — the managed/unmanaged decision

`--stdin-filepath` matters: it means we never write an unformatted intermediate
to disk, so a crash mid-save cannot leave a half-formatted file, and file
watchers never see a transient state.

Failure is always non-fatal. A formatter that errors, times out, or is missing
falls back to writing our own serialization and surfaces a dismissable warning.
Losing the user's text because a subprocess died is not an acceptable trade for
tidier whitespace.

## Settings

Frontend settings live in `localStorage` (`settings.ts:110`), but per-repo
formatter trust is a security decision and should not be trivially editable
alongside theme preferences. Consider moving this one to a Rust-side store.

- `formatter.mode`: `off` | `detect` (default) | `always`
- `formatter.trustedRepos`: repo path → resolved binary path
- Per-repo status shown in settings: detected formatter, version, and how many
  open files are managed vs unmanaged

## Performance

Save is already debounced (180 ms serialize, 2 s autosave). A subprocess
round-trip adds 100–400 ms for Prettier cold, less warm.

- Format on the flush path only, never on every keystroke
- Coalesce: if a save is queued while a format is in flight, drop the stale one
- If formatting consistently exceeds a threshold, degrade to format-on-explicit
  -save and tell the user why
- Feed timings into the existing perf HUD (`src/perf.ts`)

A long-lived formatter daemon would remove the startup cost, but that is a
follow-up — get correctness first and measure whether the latency is actually
felt.

## Open questions

- Does Prettier's markdown printer disagree with Milkdown's remark output in
  ways that survive a round trip? If Prettier normalizes something Milkdown then
  re-parses differently, saving twice could oscillate. Needs a round-trip
  fixture test before anything ships.
- Frontmatter: Prettier formats YAML frontmatter too. Our `joinFrontmatter`
  deliberately re-emits the original block verbatim (`matter.ts:43`). Formatting
  the whole file hands that decision to Prettier — probably correct, but it
  changes existing behaviour.
- Should the source view (`SourceView.tsx`) format on save as well, or stay raw?

## Next

- [ ] Round-trip fixture test: Milkdown output → Prettier → Milkdown parse, assert stable
- [ ] `detect_formatter` + `check_formatted` commands, Prettier only
- [ ] Managed/unmanaged decision on file open, cached per session
- [ ] `format_markdown` via `--stdin-filepath`, wired into `flush()`
- [ ] Trust prompt and per-repo persistence
- [ ] UI indicator for unmanaged files with an explicit format action
- [ ] Extend detection to dprint and markdownlint
- [ ] <br />

