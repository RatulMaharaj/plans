---
status: done
---
# See Every File, Not Only The Markdown

The tree shows `.md` and `.markdown` and nothing else (`lib.rs:308`, the
extension check inside `walk_markdown`). That is right for reading plans and
wrong the moment you want to look at what is beside them — the skill file, a
config, the source a plan is arguing about. Today that means leaving the app.

A toggle, then: **All files**, off by default, beside "Show finished plans" in
Settings → Files.

## The rule that keeps it honest

There are two editor modes, and only two: **Write and Source**. Diff is not a
per-buffer mode any more — it belongs to the git tools, where reviewing a PR
or a changed file actually happens, and it should stay there.

A file that is not markdown must not open in the writing surface. Milkdown
parses markdown into a document and serialises it back; hand it TypeScript and
it will render something, and saving that something would rewrite the file
into whatever the round trip produced. That is not a risk worth taking for a
convenience feature.

So: **Write is disabled for anything that is not markdown**, and such a file
opens in Source. The switch already lives per buffer (`App.tsx:244`), and the
mode row already hides itself for memory buffers — the same idea, one more
reason.

- The mode row shows Source only.
- ⌘1 (Write) does nothing on such a buffer rather than silently switching.
- The frontmatter panel, the status badge and the comment actions are all
  markdown conventions and should stay hidden.

## What changes where

- **Rust.** `walk_markdown` grows a flag, or a sibling that keeps everything.
  The name stops being true either way; `walk_files(root, include_ignored,
  only_markdown)` says what it does. `list_plans` passes the setting through
  the way it already passes `include_ignored`.
- **Settings.** `showAllFiles: boolean`, default false, next to
  `showCompleted`. A palette toggle in the Files group, worded Show/Hide.
- **The tree.** Nothing, if the walk returns more — except the name.
  `displayName` (`FileTree.tsx:140`) strips `.md` and then replaces every dash
  and underscore with a space, which is right for `improved-hotkeys.md` and
  wrong for `my_module.rs`: it would read as "my module.rs". Prettifying a
  name is a markdown-plan convention, so it should apply to markdown only.
- **Editing.** `openFile` decides the initial view: markdown keeps its
  remembered mode, anything else is forced to Source.

## Open questions

- Binary files. A PNG in the tree is either an image preview or a wall of
  bytes; the app already reads assets as data URLs for the editor, so a
  preview is not far away — but "all files" should probably still mean text
  until someone asks otherwise.
- Does this want a size ceiling? A repository with `node_modules` is already
  excluded by the ignore walk, but a large generated file is not.
- Should the toggle be per repository rather than global? A plans repo wants
  markdown; a code repo with a `plans/` folder in it may want everything.

## Done when

- The toggle shows every text file in the tree, and off returns to markdown.
- A non-markdown file opens in Source, cannot be switched to Write, and cannot
  be rewritten by the editor.
- Extensions are shown for files whose extension is the point.

## Next

- [ ] `walk_files` with a flag, and `list_plans` threading the setting
- [ ] `showAllFiles` in settings, the palette, and Settings → Files
- [ ] Drop Diff from the per-buffer mode row; it lives with the git tools
- [ ] Force Source for non-markdown, and hide Write rather than disabling it
- [ ] A test that a `.ts` file cannot reach the writing surface

