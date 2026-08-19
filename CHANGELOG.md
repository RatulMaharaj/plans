# plans

## 0.3.0

### Minor Changes

- a3f0dc0: Plans can talk to a coding agent about the work in front of you.

  ⌘J opens a conversation beside or below the document — one per repository, so
  clicking another plan carries it rather than resetting it; which plan you are
  looking at rides the next turn as context. Ask for anything: the answer
  streams in, and edits the agent makes land in the files where the watcher, the
  tree marks, and git already show them.

  "Hand off to agent" starts that conversation on a particular plan, from its
  right-click menu in the tree or from the palette. What the agent is told is
  yours to edit, in Settings → Agents, alongside the agent itself — picked from
  the ones found on your machine rather than typed. The app runs it headlessly
  one turn at a time, never in the background, and never commits.

  Machines without an agent CLI see none of it rather than a chat that fails.

- 310455d: The git panel gets the same header bar as the chat and the tabs, with pull and
  push in it as “Pull ↓” and “Push ↑” carrying their counts. The branch picker
  moved up to the rail beside the repository, the commit box moved to the top of
  the panel, and the repository's name is no longer repeated inside it.

  Pull no longer refuses when you have unsaved work: it stashes it, pulls, and
  puts it back, rebasing unless the repository says otherwise.

  The panel buttons leave Settings when pressed, instead of toggling something
  you cannot see from there.

- bce1cc0: Collaboration, without accounts. Comments are markdown-native HTML comments:
  right-click or ⌘⇧M writes one after the paragraph, signed with whatever
  `git config user.name` says. A comment with several `@name:` lines renders as
  a thread, and the card grows a reply field that appends one more line to the
  file. The frontmatter gets read as well as edited: `status:` shows as a badge
  in the header and a tinted dot on the tree row, `owner:` and `due:` in the
  header — read-only, from a few conventional keys the app recognises but does
  not own.
- 711dd62: The sidebar's right-click menu grows two things. Reveal in Finder, on files,
  folders and repositories alike. And Delete folder — which counts what the
  folder holds before asking: the tree only shows markdown, so the confirmation
  says how many files are inside and how many of them you have never seen.
- cab1043: Settings → Files gains "Finished plans", which hides everything marked done
  and everything inside a `completed/`-style folder. It is a view of the tree:
  nothing moves on disk, git still sees every file, and a finished plan you
  already have open stays open.
- 5367ebf: `plans .` in a terminal now opens that repository in the app. Settings →
  Repositories has an Install button that puts a small `plans` script on your
  PATH (Homebrew's bin, or /usr/local/bin); the script launches the app with the
  path and gives the terminal its prompt back.

  If Plans is already running, a second `plans <path>` doesn't open a second
  copy — the running window is focused and the repository is added there, by way
  of the new single-instance plugin.

- 777e7f4: The frontmatter got faster to write. The palette now sets `status:` directly —
  one command per status, plus a clear — and _Scaffold frontmatter_ lays down
  title, status, owner and due in one stroke, filling in the filename, the first
  configured status and the git identity, then opens the sheet for the blanks.
  The status vocabulary itself is a setting, comma-separated, under Files.
- 117c5dc: Write, source, and diff are now remembered per buffer rather than being one
  app-wide switch: flip a file to source, click another tab, and each keeps its
  own mode — across restarts too. The three buttons moved up into the rail,
  and opening a file from the git panel lands in its diff without disturbing
  any other buffer's mode. Settings is no
  longer a view of a buffer, so opening and closing it touches nothing.
- 117c5dc: Each repository row in settings gains an "Install skill" action, which writes
  the plan-writing conventions — frontmatter rules and the draft/ready/busy/done
  lifecycle — to `.claude/skills/plans/SKILL.md`, where coding agents discover
  them. The text is bundled from the canonical `skills/plans/SKILL.md` at build
  time; installing over an edited copy overwrites it, leaving the change as a
  reviewable git diff.

### Patch Changes

- cab1043: Fixes three ways the window could go blank. The first status poll of a
  repository compared the new status against one that did not exist yet and
  threw; a file opened from a path that was never added to the list took the
  diff view down with it; and an unfinished merge or rebase is now said out
  loud in the git panel — conflicted files get their own mark in the tree and
  their own list, with pull and push held back until the merge is finished.

- b294606: The status vocabulary is now the lifecycle the files actually live: `draft`
  (a human wrote a seed, an agent should flesh it out), `ready` (fleshed out,
  implementation can start), `busy` (a session is on it now), `done`. An
  uncustomised saved status list migrates to the new default; edited lists are
  untouched. The conventions ship in the repo as `skills/plans/SKILL.md` so
  agents can read them.
- 711dd62: Buttons, tabs, the header rail and the status bar no longer highlight as text
  when dragged across. Chrome is furniture; only the document and the inputs
  hold selectable text.
- 117c5dc: Esc while typing hands focus back to the app, so ⌘B and the other chrome
  shortcuts work without reaching for the mouse. The active tab's top rule now
  reads as a cursor for the tab row — bright while keystrokes go to the
  document, dim while they go to the app. In zen, Esc blurs first and a second
  Esc leaves zen.
- cab1043: Settings stops offering what it has already done: the command-line and skill
  buttons read the state first and say "Installed", or offer "Update" when the
  copy on disk is from an older build.
- 711dd62: Empty folders deleted outside the app no longer haunt the sidebar. They live
  only in the app's own memory, and that memory now checks the disk on every
  refresh instead of assuming a folder it once made is a folder that still
  exists.

## 0.2.0

### Minor Changes

- Anonymous usage counts, so the app can be improved by something other than
  guesswork — which views get used, which settings get changed, how often files
  get saved. Nobody is identified, and no file name, path, or word of your
  writing ever leaves the machine. Settings → Privacy turns it off.

## 0.1.0

### Minor Changes

- First release. A WYSIWYG editor for the plans folders across your local git
  repositories: a file tree over every repo you open, three views of the same
  buffer — write, source and diff — frontmatter held apart from the prose,
  folders and drag-and-drop, a command palette, and a git panel that stages,
  commits and pushes without leaving the app. It updates itself, and shows you
  what changed when it does.
