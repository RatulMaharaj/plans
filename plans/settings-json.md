---
status: done
---
> **Implemented, but the PR could not be opened — a human has to press the
> button.** The work is finished and pushed as `impl/settings-json` (commit
> `f307ad4`, branched from this branch's tip). `gh pr create` fails with
> *"GitHub Actions is not permitted to create or approve pull requests"*, which
> is a repository setting, not anything about this plan: **Settings → Actions →
> General → Workflow permissions → "Allow GitHub Actions to create and approve
> pull requests"**. Until then, open it by hand:
>
> ```
> gh pr create --base plans/settings-json --head impl/settings-json \
>   --title "Settings as a file"
> ```
>
> Two other things that need a hand, both for the same reason — the run's token
> may not push `.github/workflows/`:
>
> - The CI step that runs `pnpm run schema:check` had to be dropped from the
>   commit. It belongs immediately before the "Types" step in `ci.yml`:
>
>   ```yaml
>         # The settings schema is generated from the Settings type. A copy that
>         # drifts is a schema that lies, which is worse than no schema at all.
>         - name: Settings schema is current
>           run: pnpm run schema:check
>   ```
>
> - `cargo fmt` / `clippy` / `test` were not runnable in the run's environment;
>   CI covers them once the PR exists.
>
> Left at `busy` rather than returned to `ready` on purpose: the implementation
> exists, so a second worker picking this up would duplicate it. Flip it to
> `ready` only if the branch is abandoned.

# Settings As a File

We currently save our settings to localStorage. Instead we should save them to
a file that can be edited the way VS Code's can, with a JSON schema to point
at. The seed is right, and the reason is the app's own thesis: this is a tool
built on the belief that plain files people and agents can both read beat
opaque state. The settings are the one piece of the app's own state that
argues the opposite — a blob under `plans.settings.v1` (`settings.ts:248`)
that cannot be versioned, synced, diffed, or handed to the agent that is three
feet away in the chat panel and perfectly capable of editing JSON.

## What moves, and what stays

Not everything in localStorage is a setting. The `Settings` type
(`settings.ts:6`) is the deliberate list — "everything the reader can
change, in one place" — and it is the only thing that moves. Around it lives
window furniture: open tabs, repo list, split ratios, the last active repo
(`App.tsx:86-96`), split state (`App.tsx:1820-1902`), and the chat transcripts
(`chats.ts:19`). VS Code draws exactly this line — `settings.json` versus
workspace state — and it is the right line: furniture is what the app
remembers about itself, settings are what you *told* it, and only the second
is worth editing by hand or carrying between machines. Moving the furniture
into the file would fill it with `"splitRatio": 0.47`, which is noise that
buries the signal.

One wrinkle inside the type itself: `treeWidth` and `lastSeenVersion` are
already acknowledged as "not settings in the sense a person would recognise"
— the telemetry filter says so in as many words (`App.tsx:183-185`). They ride
along anyway. Splitting the type to relocate two keys buys a migration for no
reader-visible gain; the schema can mark them as app-managed instead.

## Where the file lives, and how the app boots from it

The file goes in the platform config directory (Tauri's `app_config_dir`) as
`settings.json`, read and written by two new Rust commands. It cannot go
through the existing file commands — `read_plan` and friends are repo-relative
by construction (`lib.rs:636`), and the settings file belongs to the app, not
to any repository someone happens to have open.

The hard constraint is boot. localStorage is synchronous, and the app leans on
that twice before React has drawn anything: `main.tsx:13` reads
`loadSettings().telemetry` at module scope, and `applySettings` sets the theme
and type CSS variables (`settings.ts:278`) — done late, that is a flash of
default paper in whatever theme you did not choose. A Tauri `invoke` is async;
a naive port paints the wrong theme every launch.

So: the file is canonical, and localStorage stays on as a boot cache. Launch
reads the cache synchronously exactly as today, then reads the file and
reconciles — if the file differs (edited outside, synced in from another
machine), the file wins and the cache is rewritten. Every save writes both
(`App.tsx:544-545` already funnels every change through one effect, so this
is one function's change). The cache is never edited by anything but the app,
so the reconciliation has no third author to fear. This is not two sources of
truth; it is one source of truth and a warm start.

Migration is the same code path with the arrow reversed: first launch with no
file on disk writes the current localStorage blob to it, and the resilient
merge-over-defaults load (`settings.ts:254`) means a file from any older
build — or a half-deleted one — still opens the app.

## Editing it, and watching it

"Editable like VS Code" is two promises: you can get to the file, and your
edits take effect without a restart.

Getting to it: a palette command and a button on the settings page — "Open
settings file (JSON)". The app is a markdown editor, deliberately; its source
view is CodeMirror in markdown mode (`SourceView.tsx:16`) and its buffers are
repo files plus the one `MEMORY` sentinel for in-memory documents
(`App.tsx:117`). Teaching the buffer system a third kind of thing — an
absolute-path JSON file with its own language mode, outside every repo's save
machinery — is real cost for a file you visit four times a year. Open it in
the system's default editor instead (the `reveal_in_finder` shape,
`lib.rs`, already crosses this bridge for repo files). If it turns out people
live in this file, an in-app JSON buffer is a later plan with its own
argument.

Edits taking effect: the app already believes in polling for outside writes —
`watchSeconds` re-checks the open document and the tree (`App.tsx:2253`,
`App.tsx:871`). The settings file joins that rhythm: poll its mtime, reload on
change, `applySettings` on the result. Editing the theme in another editor and
watching the app change on save is the moment this feature proves itself —
and it is also how the chat's agent gets to change your settings when asked,
with no new tool surface at all: it edits a file, the watcher notices, done.
A malformed save must not detonate anything: the load already swallows parse
errors into defaults (`settings.ts:269`); the watcher should instead keep the
last good settings and toast that the file does not parse, because "you have
a typo" is recoverable and "your settings reset" is rage.

## The schema

Hand-writing a JSON Schema for a type that already exists is signing up to
maintain the same list twice; the copies will drift, and a schema that lies is
worse than none. Generate it from the `Settings` type at build time
(`ts-json-schema-generator` or equivalent) — and this repo is unusually well
positioned for that, because the type is already documented the way a schema
wants: every field carries a doc comment written for a reader
(`settings.ts:25-31`, `settings.ts:108-117`), the unions (`"afterDelay" |
"onBlur" | "manual"`, `settings.ts:29`) become enums, and `RANGES`
(`settings.ts:235`) supplies the numeric minimums and maximums the type alone
cannot express. The generator turns comments into `description` fields, so
the hover-help in VS Code is the same prose the settings page argues in.

The schema ships two ways: written beside the file as `settings.schema.json`
with a relative `$schema` reference — so completion works offline, on this
build's actual keys — and published at a stable URL from the site for anything
else that wants it. The local copy is rewritten on every app update, which is
what keeps it honest across versions.

One consequence worth naming: `keyOverrides` is documented as "edited from
the shortcut sheet (⌘/), not by hand" (`settings.ts:156`). A schema-completed
JSON file makes by-hand editing respectable — the comment, and the stance,
should soften to match.

## Open questions, answered

- **The statuses normalisation hack survives.** It is not localStorage's
  quirk, it is a blob's: one can arrive from an older build through the cache,
  through the file, or now from another machine entirely. It moved into
  `mergeSettings`, which is the one door both readers come through.
- **An outside edit does count as `setting_changed`.** The "diff the blob"
  machinery turned out to be a shallow compare over `Object.keys(DEFAULTS)` in
  the watcher — ten lines, not a project — and a knob turned in a text editor
  is a knob turned.
- **The path is shown**, in a "Settings file" group on the settings page, beside
  the button that opens it. The config directory differs per platform, so
  "where is my file" gets an answer without a document.
- **Unknown keys are kept**, VS Code's way. They are parsed aside as `Extras`
  and written back on every save, so a file edited by a newer build survives
  being opened by an older one. The cost named here was real and paid: a save
  writes the parsed file's keys plus the app's, not the `Settings` object alone.
- **No JSONC.** A lenient parser plus a comment-preserving writer is real
  machinery, and the schema's hover-help carries the prose comments would have.
  If annotating the file turns out to matter, it is its own plan.

## Next

- [x] Rust: `settings_read` / `settings_write` against `app_config_dir`, plus
      the file's mtime for the watcher
- [x] Boot: cache-then-file reconciliation; file canonical, localStorage warm
      start; first-run migration from the existing blob
- [x] Save path: the one effect at `App.tsx:544` writes both destinations
- [x] Watch: settings file joins the `watchSeconds` poll; last-good-plus-toast
      on a parse error, never a silent reset
- [x] Schema generation from the `Settings` type at build, `RANGES` folded in;
      written beside the file, `$schema` wired, published on the site
- [x] "Open settings file" palette command and settings-page button, opening
      in the system editor
- [x] Decide the unknown-keys and JSONC questions before writing the writer
