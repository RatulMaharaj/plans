---
status: ready
---
# Custom new files

> We currently have this concept of creating a new plan which is just: a new
> markdown file, with some front matter. I would like people to be able to
> define a custom file type and save it and be able to quickly create that
> either via command palette or right clicking in/on a folder. The existing
> new plans should be the default ones that are shipped. Other examples for
> this type of feature would include a daily note (also included by default -
> file named according to a convention, blank file). These files need to be
> saved in a location on the users machine and should be openable and
> editable. Frontmatter used to set params. The above are just examples -
> rethink how this works properly. We need to configure these in settings.

## What "new file" is today

There is exactly one kind of new file, and its shape is split across three
layers. The frontend asks for a title and slugs it into `<slug>.md`
(src/NameSheet.tsx:53), remembers which folder the last plan landed in
(src/App.tsx:3153-3161), and passes the first word of the configured status
vocabulary along (src/App.tsx:3163-3169). The backend then hardcodes the
actual bytes: `---\nstatus: {s}\n---\n# {title}\n\n`
(src-tauri/src/lib.rs:666-670). The entry points are ⌘N / the palette's "New
file" (src/App.tsx:4543) and the tree's right-click "New file here"
(src/FileTree.tsx:733).

So "a plan" is the only file the app knows how to make, and its template
lives in Rust. To add a daily note today you would edit the backend. That is
the thing to fix: the template belongs to the user, and the backend should
only know how to write bytes it is handed.

## A template is a markdown file

The seed suggests the design and it holds up: a template is itself a markdown
file, with frontmatter for its parameters and the body as the scaffold that
gets stamped out. This beats a JSON blob in settings for three reasons. The
app is already a markdown editor, so templates are openable and editable in
the tool the user is already in, which is what the seed asks for. The body of
a template is literally the body of the file it creates, so what you see is
what you get. And frontmatter-as-config is the convention this whole app is
built on; users already know it.

Templates live in `~/.plans/templates/`, one file per template. There is
precedent for the app owning this directory: it already writes fresh skill
copies into `~/.plans/skills/` on every launch. The difference is ownership -
skills are the app's and get overwritten; templates are the user's and never
are. On first launch the app seeds the directory with the two defaults
(`plan.md`, `daily-note.md`) only if they are missing, so editing or deleting
a default sticks.

A template's frontmatter:

```yaml
---
name: Plan
fileName: "{slug}.md"
prompt: title
frontmatter:
  status: "{firstStatus}"
---
# {title}
```

```yaml
---
name: Daily Note
fileName: "{date:yyyy-MM-dd}.md"
prompt: none
---
```

- `name` is what the palette and context menu show. Required; a file without
  one is skipped with a notice rather than guessed at.
- `fileName` is a pattern. Tokens: `{slug}` (from the prompted title),
  `{date:...}` (today, in the given format), `{title}` raw. A pattern with no
  `{slug}` or `{title}` needs no prompt, which is what makes the daily note
  one keystroke.
- `prompt: title | none` says whether the NameSheet appears. Default is
  `title` when the pattern mentions the title and `none` when it doesn't, so
  the key is usually omitted.
- `frontmatter` is a map written verbatim into the new file's frontmatter.
  Values may use the same tokens, plus `{firstStatus}` for the first word of
  the statuses setting (src/settings.ts:65), which is how the shipped plan
  template reproduces today's behaviour exactly.
- Everything below the frontmatter is the body, tokens substituted. An empty
  body means a blank file, which is the daily note.

The alternative worth naming is storing templates as entries in
`settings.json` (the platform config directory, src-tauri/src/lib.rs:859-864).
It loses on every axis above - multi-line bodies in JSON strings are
miserable to edit - so settings only gets a pointer: a row in the Files
section of the Settings page that shows the templates folder, lists what was
found there, and opens the folder. Configuration stays in the files.

## How creation changes

The palette grows one command per template, "New: Plan", "New: Daily Note",
built from the directory listing the same way the per-skill "Open the … 
skill" commands are built today. ⌘N keeps meaning the first template
(alphabetical, `plan.md` first among the defaults), so the existing muscle
memory changes nothing. The tree's "New file here" (src/FileTree.tsx:733,755)
becomes a small submenu of template names when more than one template exists,
and stays a single item when only one does.

The flow through the frontend barely moves: `newPlan` becomes
`newFromTemplate(t)`, the NameSheet appears only when the template prompts,
and `createFile` renders the template to a full string instead of shipping a
status word. The backend's `create_plan` (src-tauri/src/lib.rs:646) gets a
sibling `create_file(repo, relPath, content)` that keeps the exists-check and
`safe_join` but writes the content it is given; `create_plan` can then be
reimplemented over it or retired. Rendering happens in the frontend because
the vocabulary token and the template files are both frontend concerns
already.

One behaviour is worth special-casing: a date-named file that already exists
is today's note, so "New: Daily Note" on an existing file opens it rather
than erroring. The exists-check in the backend stays; the frontend checks
first for prompt-less templates and opens on a hit.

## Out of scope

- Per-repository templates (a `.plans/templates/` in the repo). Plausible
  later; the machine-level folder answers the seed and keeps discovery to one
  directory.
- A template-editing UI. The files are the UI; Settings only points at them.
- Cursor-position markers, snippet variables, or anything TextExpander-shaped
  inside the body. Tokens stay the small fixed set above.

## Open questions

- Should the daily note default into a fixed folder (`notes/` or `daily/`),
  or into the last-used directory like plans do (src/App.tsx:3171-3174)? A
  `dir` frontmatter key on the template would answer it; I have left it out
  until the answer is known.
- Is `~/.plans/templates/` right, or should templates sit beside
  `settings.json` in the config directory? The `~/.plans/` spelling is easier
  to say and already exists; the config directory is more conventional.
- Does the palette need fuzzy access to templates under the bare word "new"
  plus the template name, or is the "New: X" prefix enough?

## Next

- [ ] `src-tauri/src/lib.rs` - add `create_file(repo, relPath, content)`
      beside `create_plan`; keep `safe_join` and the exists refusal
- [ ] `src/api.ts` - expose `createFile`, deprecate the status-word
      `createPlan` signature
- [ ] `src/templates.ts` (new) - discover `~/.plans/templates/`, parse
      frontmatter, render tokens (`{slug}`, `{title}`, `{date:...}`,
      `{firstStatus}`), seed the two defaults when missing
- [ ] `src/App.tsx` - `newPlan` → `newFromTemplate`; skip the NameSheet for
      prompt-less templates; open instead of create when a prompt-less
      target exists
- [ ] `src/Palette.tsx` - one "New: <name>" command per discovered template;
      ⌘N binds to the first
- [ ] `src/FileTree.tsx` - "New file here" becomes a template submenu when
      more than one template exists
- [ ] `src/SettingsPage.tsx` - a Files row naming the templates folder,
      listing what was found, with an "Open folder" action
