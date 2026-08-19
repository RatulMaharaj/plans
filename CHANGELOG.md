# plans

## 0.4.0

### Minor Changes

- Chats can be renamed and deleted, from the panel header and the palette.
  Deleting asks only when there is something to lose, and deleting the only one
  leaves a fresh conversation rather than an empty panel.

  Settings lists every supported agent — Claude Code, Codex, Gemini, OpenCode —
  with where you stand on each: chosen, installed, run via npx, or not here at
  all, with a button rather than a command to copy out. Each says how to sign in
  before it needs to, and an agent that starts but will not answer repeats that
  in the chat: "API key is missing" is true and useless on its own, because the
  fix happens in a terminal.

  Quitting now waits for agents to actually stop before the app goes, rather than
  asking them to and exiting first — which could leave one running.

  ⌘D no longer opens the diff; ⌘3 does. There is a new "Close all editors"
  command, and panel commands in the palette say show and hide rather than turn
  on and off.

- be44131: A repository can have more than one conversation. The chat's header names the
  current one — after the first thing you said in it — and picks between them;
  **New** starts a fresh one and ends the agent's session with it, because a new
  conversation the agent still remembers the last one from is new in name only.

  `/clear` now does what it looks like it does. Sent on to the agent it cleared
  the agent's context and left the transcript on screen, which was
  indistinguishable from nothing happening; it is the same intent as New, so it
  is the same action.

  Both live in the command palette too: "New chat", and every other conversation
  by the name it gave itself.

- 690e226: Release notes open as an ordinary markdown buffer rather than a pop-up sheet —
  a tab you can read at your own pace, scroll, and close, rendered by the same
  editor as everything else. They also cover every version since the one you
  last read, so skipping a release no longer means skipping its news.

  The buffer lives in memory: nothing is written to disk, and it is not restored
  on the next launch.

- ab627e1: Searching inside files is now `*` rather than `?` — a wildcard is what people
  already type for "anything containing this", where a question mark read like a
  question.

  `#` lists the repository's conversations and takes you to one, marking the one
  you are already in — written the way a channel is, and leaving `@` free for
  mentioning a file in a prompt, which is what ACP agents already use it for.

- 3865308: The chat has a model picker, a reasoning-effort dropdown and slash commands —
  none of which this app knows anything about. The agent advertises what it has
  when the session opens, and the panel draws a dropdown per option in whatever
  order they arrive; choosing one asks the agent and redraws from its reply,
  because a choice can change what else is on offer.

  Typing "/" completes from the commands the agent advertised, with arrows and
  Tab. Completing is not sending — the agent parses the slash itself — and a
  slash you meant literally still goes through.

  Context used and what the turn cost appear in the status bar once the agent
  reports them.

- When an agent asks permission before it acts, the question appears in the
  transcript with the agent's own choices as buttons, and the turn waits for your
  answer. Answering freezes it into a statement rather than leaving it pressable,
  and a question left unanswered when the window closed comes back inert — the
  process that asked it is gone.

  How often you are asked is the agent's own permission mode, chosen from the
  pickers in the composer: Auto classifies without asking, Manual asks about
  everything, Plan Mode runs nothing at all.

- 9690bc5: The chat speaks the Agent Client Protocol.

  Instead of building one CLI's flags and parsing one CLI's output, the app is
  now an ACP client: it starts an agent that speaks the protocol and draws what
  that agent says. Which models exist, which reasoning levels, which slash
  commands, whether a tool needs asking about — none of it is knowledge the app
  holds any more. A second agent is a row in a table rather than a second parser.

  Tool lines now carry the title the agent wrote for them, and finish: a call
  goes from running to done in place instead of appending a second line.

  The chat starts fresh. Earlier transcripts are left on disk but not shown: a
  Claude CLI session id means nothing to an ACP agent, so a conversation carried
  across would be a conversation only on one side.

- 51f02d3: The agent's task list appears above the transcript while it works, amended in
  place as it goes. A session survives the process: if the agent dies between
  turns, the next thing you say asks it to pick the conversation back up rather
  than starting over.

  Answers render as markdown — bold, code, fences and lists — by building
  elements rather than injecting markup, so an agent quoting HTML from a file
  shows you the HTML instead of running it. What you typed is still shown exactly
  as you typed it.

  Codex, Gemini and OpenCode are in the agent list alongside Claude Code. They
  were never a second integration; they are rows in a table.

### Patch Changes

- c69e1af: The message box starts three lines tall and grows as you type, up to a ceiling
  past which it scrolls.

  The agent's pickers no longer clip or scroll: a menu shows every option at
  once, with descriptions whole, because a picker you have to scroll is a picker
  you have to search.

  Choosing a different agent now actually changes which one answers. The running
  session ends at the next thing you say, the transcript stays, and the new agent
  starts without it — a session id belongs to the agent that opened it.

- 4c4a307: Marking a plan done now updates the tree immediately — hiding it when finished
  plans are hidden, and changing its badge otherwise — instead of waiting for the
  next background refresh to read the file back.
- d66c658: An installed agent is preferred over fetching it with npx on every launch, and
  Settings → Agents will install it for you. The row says which of the two it
  will actually do, because the difference is a second or two on the first prompt
  of every session.
- cd96eac: Deleting a file, discarding changes, forgetting a repository and removing a
  frontmatter block all ask again — properly. They used `window.confirm`, which a
  WKWebView swallows without showing anything, so "ask, then delete" had quietly
  become "delete". They now put up a real native sheet whose button names the act:
  Delete, Discard, Forget, Remove.
- 70c3095: The tree's right-click menu stays on screen: near the bottom or right edge it
  flips and clamps instead of running off the window.

  ⌘⌫ deletes the selected file, after asking, and only while the tree has focus —
  everywhere else the chord already means something. F2 renames the open file.

  The finished-plans setting says what it does: "Show finished plans", shown or
  hidden, rather than a switch whose "off" read as though it turned the plans off.

- bf29a12: The agent's model, effort and mode pickers moved into the composer, under what
  you are typing — they set what happens next, so they belong with the message
  rather than reading as a status bar above the conversation.

  They can no longer stretch the window: an option with a long name, or an agent
  persona whose description runs to paragraphs, used to push the whole app
  sideways. Menus now hang from the button's right edge and grow back into the
  space that is there.

  Effort is ordered as the scale it is, lowest nearest the button.

- e534c71: The chat could produce nothing but your own message when the app was started
  from Finder rather than a terminal: a GUI app inherits launchd's PATH, which
  holds none of the places an agent CLI is actually installed. The binary is now
  resolved through your login shell's PATH, so the app finds what your terminal
  finds.

  The narration reads like the terminal too. A tool call shows what it touched —
  "Read plan.md", "Bash pnpm test" — rather than a bare tool name, and a turn
  that fails says so in the transcript instead of only in a toast that is gone
  by the time you look back.

  The update banner's two actions are spaced apart, and its labels no longer
  break across lines.

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
