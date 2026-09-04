# looped-plans

## 0.10.0

### Minor Changes

- c24c3fd: Share any plan as a public page. "Share…" is now in every file's page head,
  not just a workspace's: it publishes the plan to `plans.looped.sh/{id}` and
  puts the address on the clipboard. A file in a repository republishes on
  every save while sharing is on, so the page follows its author; a workspace
  document's page reads the room, so it follows the argument. A shared plan
  shows "Shared" in the page head, and the way to stop is behind it — stopping
  kills that address for good. The id is the whole of the secret: no session,
  no fragment, no token, and the page is not indexed.

  The page is the app's own renderer, built as a second Vite entry
  (`pnpm build:share`) and served by the workspace server, so mermaid, tables,
  code, the frontmatter chip and the theme are the same ones the editor draws —
  there is no second renderer to drift. Links minted before this land on their
  document's page instead of the old viewer, which is gone. Everything the app
  asks the server for moved under `/api` to leave the root to the reader; the
  old addresses still answer, so a build already on your machine keeps working.

- 0d3f4eb: A workspace is a folder of files, not one document. It joins the file tree as
  a heading of its own, with its folders and files under it, and takes the same
  gestures a repository does: new file, new folder, rename, move, delete —
  each one a transaction on a shared tree, so everyone in the workspace sees it
  land at once and two people acting together merge rather than fight. A rename
  carries the document with it, so whoever is mid-sentence in a file stays
  mid-sentence in it. What is disk-only goes dark for a workspace: no git marks,
  no Reveal in Finder, no terminal, no path to copy.

  The read endpoint and share links reach files rather than workspaces:
  `GET /w/{id}/` lists the folder, `GET /w/{id}/{path}` answers with one file,
  and a share link names the file it opens — the viewer draws mermaid fences as
  diagrams now, too. `plan.md` keeps answering everywhere it used to, and a
  workspace made before this keeps its document under that name.

  The review gate is retired. `status:` in the file's own frontmatter and
  `approved` as a human's word say what the gate said, and they travel with the
  file into the repository instead of staying behind on a server; the page head
  shows the file's status badge, as it does for any other file. Copying a plan
  out to a repository revokes the workspace's share links, since the document
  they point at is a file with a repository's own rules now.

### Patch Changes

- 932b6c7: Faces: your picture beside your name when signed in, and everyone else's
  beside the workspace files they have open and at the top of the one you are
  in, drawn from the same presence that draws their cursors. A workspace file
  gains a read-only Source view. The public page gets the app's three papers
  as a switch, kept in the reader's browser.
- 4d4368d: A workspace can be left, or deleted by whoever made it, from its heading's
  menu in the tree. Deleting closes it for everyone in it and kills its pages.
  Your profile now sits at the foot of the sidebar, with sign-out beside it,
  rather than in the rail.

## 0.9.0

### Minor Changes

- cbbd7bf: The agent in the chat can change any setting. A new bundled skill tells it
  where `settings.json` lives on each platform, to read the generated schema
  before writing rather than guessing keys, and the etiquette of writing the
  file back: one write, keep `$schema`, keep the keys this build does not know,
  leave the app-managed ones alone. It installs with the other skills. The
  settings poll no longer shares `watchSeconds` with the document watcher, so
  someone who has turned repository watching off still sees the change land -
  that knob was the one way the settings file could wedge itself shut.
- 6ae296c: Workspaces: a room where a plan gets argued before it is a file. Sign in
  from the rail, make a workspace, invite people by email, and edit one
  markdown document together with everyone's cursor in it. Request a review
  when it settles; someone other than you approves it, which the server
  enforces. "Copy to repository…" then writes the document into a repository
  as an ordinary file, stamped `status: ready` and `approved-by:` when it was
  approved, and everything downstream — agents, the factory, git — works as it
  always has. The workspace server ships in this repository under `server/`:
  one Node process on Postgres, as a container with its secrets from Infisical;
  the app keeps its session in the OS keychain, never in `settings.json`.
- e38e198: The app is called Looped Plans. The wordmark in the rail, the window title and
  the bundle's product name, the update banner and the "you are on the latest
  version" notice, the settings hints, the dialog titles, the release-notes
  heading, the README and the site all say the new name; the generated settings
  schema says it too. The package is now `looped-plans`, so a changeset names it
  that from here on.

  What deliberately did not move: the bundle identifier and the updater endpoint,
  which are how an installed copy finds its own updates, and the `plans` command
  on your PATH. The macOS bundle is now `Looped Plans.app` — the installed shim
  carries the app's name in its comment, so an existing one reads as stale and
  Settings offers "Update" rather than claiming nothing is installed.

- bf7dcb9: Share a workspace document with a link. "Share…" in a workspace's page head —
  or "Copy share link" in the palette — mints a link anyone can open in a
  browser with no account, no app and no clone: the document at reading width,
  read-only and live, with the workspace name and its status and review chips,
  and a print stylesheet so ⌘P is the export button. The secret rides in the
  URL's fragment, which browsers never send, so the server's log and any link
  unfurler see an empty `/share` page and nothing of the document, and the page
  carries the review state but never the member list. Each link is its own
  token: the same sheet lists the live ones and revokes them one at a time, and
  revoking one breaks neither the others nor the read token the factory holds. A
  link also expires thirty days after minting — revocation answers the leaked
  link, expiry answers the forgotten one — and expired, revoked and never-minted
  all read alike. The app also now points at the workspace server's `looped.sh`
  address by default, so links are minted from the right place.

### Patch Changes

- e1c76de: `pnpm dev` is the app; `pnpm web` is the web half alone, for a browser. A
  committed `.env` gives local builds the workspace server's address, so the
  app run from source has workspaces too.
- 5d7648a: More of the ⌘K family, for what the palette had and the keyboard did not:
  ⌘K P finished plans, ⌘K I gitignored files, ⌘K F frontmatter, ⌘K M move
  this file, ⌘K R reload from disk, ⌘K N new chat, ⌘K S swap the panes; and
  ⌘⇧N for a new folder.
- 66978c5: The "All files" setting is "Show all files", which is also what you type to
  find it, and ⌘K A toggles it.

## 0.8.0

### Minor Changes

- 97468fd: Questions the agent asks are now clickable. The app tells the agent it can
  render forms, so Claude's AskUserQuestion arrives as a question card in the
  transcript: the suggested answers stack one under the other as little bubbles,
  descriptions and all (with a single choice, the click is the answer), every
  question carries the tool's own "type your own answer" box, and
  Skip tells the model you moved past it rather than killing the turn. Without
  this the adapter disallowed the tool entirely and the model could only ask in
  prose you had to answer by hand.
- 74d5342: A new file is whatever you say it is. There used to be exactly one shape — a
  title, `status:` frontmatter, a heading — and it was built in Rust, so adding
  a daily note meant changing the backend.

  The shape now comes from a template, and a template is a markdown file: its
  frontmatter is its configuration, its body is the body of the file it stamps
  out. They live in `~/.plans/templates/`, beside the skills, with the ownership
  the other way round — the skills are the app's and are rewritten on every
  launch; the templates are yours, seeded once and only read after that, so
  editing or deleting one sticks.

  Two ship: `plan.md`, which writes exactly what ⌘N always wrote, and
  `daily-note.md`, a blank file named for today. A template says what it is
  called (`name`), what its file is called (`fileName`, with `{slug}`,
  `{title}` and `{date:yyyy-MM-dd}` in it), and what frontmatter the new file
  starts with (`frontmatter:`, where `{firstStatus}` is the first word of your
  status vocabulary). A pattern that never mentions the title needs no title, so
  "New: Daily Note" is one keystroke and no sheet — and asking for today's note
  when today's note is already there opens it rather than refusing.

  The palette carries one "New: …" command per template, ⌘N stays bound to the
  first, and the tree's "New file here" opens into the list when there is more
  than one. Settings names the folder and opens it; the configuration is in the
  files, not in `settings.json`.

  Underneath, `create_plan` is now `create_file`: it refuses to overwrite and
  writes the bytes it is handed, and knows nothing about what a plan looks like.

### Patch Changes

- ba70109: "Show all files" shows all folders too. The tree is built from the files a
  walk returns, so a folder with nothing in it never appeared; in all-files
  mode the app now asks the disk for the folders as well, on the same walk and
  skip rules, and merges them in. Markdown mode keeps the tree to what has
  files, as before.
- ba70109: `approved` is a recognised plan status. It gets a colour of its own in the
  tree and the frontmatter panel, sits between `ready` and `busy` in the
  default status vocabulary (an edited list is left alone), and the plans skill
  tells agents the word belongs to the human: it is their sign-off, and an
  agent treats an approved plan the way it treats a ready one.
- ba70109: The chat title truncates instead of running under the Rename button. The
  conversation picker's trigger had a fixed 220px cap, wider than a narrow
  panel's header could give it; it is now also capped by the room that is
  actually there. This pass also repaired a duplicated block in the stylesheet
  that had swallowed the rule dimming file locations on tool lines.
- ba70109: The up arrow in an empty composer walks back through the messages you sent in
  this conversation, the way a shell does; down walks forward and lands on
  whatever you had typed before you started browsing. The arrows only enter
  history from the edges of the text, so they still move the caret in a
  multi-line message being written.
- ba70109: "Copy path" in the tree's right-click menu copies the absolute path. The
  repo-relative path it used to copy could not be pasted into a terminal,
  another app, or an agent prompt without first working out where the
  repository lives.
- ba70109: Dropdown menus are no longer cut off inside sheets. The menu used to render
  inside the sheet, whose `overflow: hidden` clipped it at the edge; it now
  renders in a portal at the trigger's measured position, so the folder picker
  in the new-file sheet opens whole. It follows the trigger on scroll and
  resize, and still flips above the trigger when there is no room below.
- 97468fd: A flush now collects the keystrokes still inside the editor's typing
  debounce. Changes were reported on a pause (~180ms), so a save that ran
  sooner — ⌘S right after typing, or the rewrite seed flushing before it
  quotes the file to the agent — saw an empty buffer, called the file saved,
  and the rewrite went out quoting text that was not on disk yet.
- ba70109: The "complete this plan" handoff prompt follows the plans skill instead of
  carrying style rules of its own. The two had drifted into contradiction: the
  prompt asked for a closing "Next checklist", which the skill forbids, and
  argued against the step list the skill is built around, so an agent obeying
  the prompt wrote a plan the skill said was wrong. The prompt now names the
  move (flesh the plan out, set it ready, touch nothing else) and leaves the
  shape to the skill. A saved copy of the old default prompt moves to the new
  one; an edited prompt is left alone.
- ba70109: A message sent while the agent is mid-turn is queued and sent when the turn
  finishes, in order. It used to be dropped silently: the composer had already
  cleared the box by the time the busy guard fired, so what you typed was gone.
  The transcript says "queued" when this happens, and if the session dies before
  the queue drains, it says the queued messages went with it.
- 97468fd: A message queued mid-turn is sent into the conversation it was typed in, not
  whichever one is on screen when the turn ends — switching chats while a
  message waited could send it to the wrong conversation, or lose it to a queue
  that never drained. The in-flight guard is per conversation too, so a send in
  one chat can no longer queue a message in another.
- ba70109: The new-file sheet remembers where the last plan in each repository was
  created and opens on that folder, as long as it still exists. With nothing
  remembered it falls back to the folder of whatever is open, as before.
- 97468fd: A new file's name keeps the case you typed: "Meeting Notes" becomes
  `Meeting-Notes.md`, not `meeting-notes.md`. The `{slug}` token lowercased the
  title, so the filename silently disagreed with what was in the sheet.
- 97468fd: Stop now sits inside the composer, at the end of the options row under the
  box you type in, instead of floating above it over the transcript.

## 0.7.0

### Minor Changes

- bdd02de: A fourth bundled skill, `factory`: how an agent sets the Factory GitHub
  Action up in a repository — install the gate script and push wrapper
  verbatim, adapt the workflow's verify commands and runner to the target
  repo's own CI, keep the two load-bearing lines (the gate's skip and the
  recursion-guarded `GITHUB_TOKEN`), point the owner at `claude setup-token`
  for the subscription secret, and prove the install with a push that
  dispatches nothing. Installs with the others, opens from the palette like
  the others.
- 07f6f6d: Select a passage in the write surface, right-click → "Rewrite…", and say in a
  sentence what you want changed. The agent gets a turn that names the file,
  quotes the passage — with a line-range hint only when the quote is unique in
  the file — and carries your instruction; it edits the file, and the poll
  reloads the buffer, the same way every other handoff already works. The prompt
  is yours to argue with in Settings → Agents.
- 281eef1: A plan's `model:` and `effort:` frontmatter keys — the ones that route a
  dispatched implementation run — can be set from the palette, offering exactly
  what the live agent session advertises (ACP `model` and `thought_level`
  options) and nothing when no session is advertising: the vocabulary is the
  agent's, never the app's. The plans skill documents the keys, and the bundled
  dispatchers treat a value they don't recognise as absent — warn and fall back
  to the default — rather than failing the run over a typo.
- b264d05: Long dropdowns can be searched. Past ten choices a menu gains a filter row
  scored by the palette's own subsequence matcher, so `settings` finds
  `plans/settings-json` in a list where every name begins `plans/` — the prefix
  type-ahead a select taught everyone stays the right thing below that. No call
  site opts in: the branch picker, the folder pickers, the chat list and an
  agent's model list all inherit it from `Dropdown` itself.

  The branch list behind it grew up to match: branches that exist only on a
  remote are offered too, set apart under a rule, with checking one out creating
  the tracking branch; the list is ordered by recency rather than alphabetically;
  and the menu shows the branches it already had, saying it is refreshing, rather
  than an empty box while git takes its three seconds.

- f307ad4: Settings live in a file. `settings.json` in the platform's config directory is
  now where every setting on the Settings page actually lives, with a
  `settings.schema.json` generated from the app's own `Settings` type written
  beside it — so an editor completes this build's keys and shows the same prose
  the settings page argues in. localStorage stays on as a warm start, so the
  theme is still right on the first frame; the file wins any disagreement, and
  first launch migrates whatever was already stored. Edits made outside are
  picked up on the same interval as everything else read from disk, which is also
  how the agent in the chat panel can change your settings with no new tool
  surface at all — it edits a file. A file that does not parse keeps the last
  good settings and says so rather than resetting anything. "Open settings file
  (JSON)" is on the Settings page, next to the path, and in the palette.
- 241d7e8: The software factory's first working set. A third bundled skill, `pr`, joins
  `plans` and `review` (it slipped into 0.6.0 without a changelog line): how an
  agent turns a `ready` plan into a pull request — one unit per run, a pushed
  `busy` flip as the claim and lock between workers, a worktree from the default
  branch's tip, and fail-loudly back to `ready` as the only exit besides a PR.
  Around it, the dispatchers: `scripts/worker.mjs`, a local daemon that watches
  configured repos and spawns headless runs — fleshing out `draft` plans and
  implementing `ready` ones, so committing a draft is the whole human gesture —
  and a Factory GitHub Action that runs one matrix job per unit whose status
  _became_ `ready` in a push, billed to the Claude subscription. Both route by
  the plan's `model`/`effort` frontmatter, both confine pushes to
  `scripts/git-push.sh` (origin only, no flags, and the default branch accepts
  nothing outside `plans/`), and neither ever bypasses permissions — a scoped
  allowlist plus `acceptEdits`, the configuration `claude-code-action` already
  battle-tested in public.
- 281eef1: The handoff splits in two, named for what each asks of the agent. "Hand off to
  agent: complete this plan" is the old handoff under an honest name — flesh the
  plan out towards `ready`. "Hand off to agent: implement this plan" is new: the
  agent claims the plan as `busy`, builds what it describes, and marks it `done`.
  Both live in the palette and the tree's right-click menu, and each has its own
  editable prompt in Settings → Agents.

### Patch Changes

- 281eef1: Six open bugs closed in one pass. Stop actually stops: the session now keeps
  listening while a turn runs and sends the agent a real `session/cancel`, where
  before the press sat unread until the answer finished on its own. A maximised
  mermaid diagram opens fitted whole — no more cropped top — and a plain scroll
  wheel zooms it, so panning is reachable without knowing the ⌘-wheel gesture.
  "Open the … skill" in the palette resolves where the skill is actually
  installed (per-skill file or fenced `AGENTS.md` section) instead of assuming
  Claude Code's path. Scroll position now carries across Write and Source for
  the same file, mapped proportionally between the two layouts. `h3` steps up to
  1.13em and `h4` — which had no rule at all — gets one of its own. And a
  repository heading can be renamed from its right-click menu: an alias kept by
  the app, for worktrees and the third repo called `mono`.

## 0.6.0

### Minor Changes

- 4ead37e: ⌘K chords (⌘K W closes all, ⌘K ⌘1/⌘2 override a pane's view), a Settings → Keyboard page for rebinding everything, and opt-in VS Code and Vim keybinding packs. The palette now lives on ⌘P/⌘⇧P alone.
- 4ead37e: ⌘F finds inside the open file — one bar over the focused pane, working in both Write and Source, and a palette `*` hit now opens the file with the find seeded at the match.
- 4ead37e: An "All files" toggle shows every text file in the tree, not only markdown; non-markdown files open in Source only and can never be rewritten by the writing surface.

### Patch Changes

- d52b1b7: The file tree can now be toggled from the rail. A Files button sits with Git
  and Chat, lit while the sidebar is open — the same switch ⌘B has always been,
  now visible and clickable.
- c8d1a60: Search follows the "all files" switch, and the git panel stops filtering.
  The palette's footer carries the search scope — markdown by default, one
  click for every file — and both searches obey it: file names and the `*`
  search inside files. The git panel now always reports the whole repository:
  every changed file is listed, stageable, and openable in the diff view,
  whatever the tree shows. The source of any file is editable as typed: the
  frontmatter splitter no longer peels a `---` header off a non-markdown file
  mid-edit. Settings commands in the palette keep fixed names — "All files",
  "Finished plans", "Chat position" — with the current state in the value
  chip, instead of labels that flip between show and hide. And the diff view
  got faster where it counts: the heavy backend commands moved off the main
  IPC thread so "Reading the committed version" no longer waits behind a
  repository walk, and a git action refreshes the diff in place instead of
  blanking it while the committed side is re-read. Clicking through the git
  panel is instant now, twice over: the file opens straight into Diff instead
  of mounting the writing surface first and tearing it down, and the committed
  side of every changed file is prefetched as soon as the panel's list is
  known, so the diff paints from cache and revalidates behind it. That work
  also surfaced a real bug: switching between changed files could pair one
  file's committed side with another's working copy under a stale highlight
  cache key, leaving the diff showing the previous file — or nothing. The diff
  view is now keyed per document and its cache keys carry a content
  fingerprint, and a regression test clicks down a panel of changed files
  asserting each diff is its own and paints within budget.
- 917c684: Two chat fixes. The transcript keeps the order things happened in: streamed
  text grows its bubble only while that bubble is still the last message, so
  an answer written after tool calls lands _below_ them instead of being glued
  onto earlier prose above — the closing answer is now always the last thing
  on screen. And Stop moved out of the header, where long chat titles ran into
  it, to float just above the composer: the answer is stopped where the next
  message is typed, which Esc already did.
- d52b1b7: Diff is no longer a mode you switch an editor into. The Diff button, ⌘3 and
  the palette entry are gone; the view switch is Write and Source. The diff
  still exists where it means something — click a changed file in the git panel
  and it opens as that file's diff, and a conflict's "See the diff" still shows
  yours against the last commit. While a buffer is showing a diff, a lit Diff
  segment appears on the switch so there is a way to read the state and a way
  back out.

  Comments also now land at the cursor — in whichever paragraph it sits, right
  where you pointed — rather than being appended after the paragraph's end.

## 0.5.0

### Minor Changes

- 3c9385b: The app now ships a second skill: a review skill that teaches any agent how to
  turn a branch or PR into review materials a human can actually digest — a
  small numbered set of documents split by what the reader does, mermaid where
  prose loses, code blocks as quotations with `file:line`, and statuses that
  make the tree a reading checklist.

  Install conventions installs every bundled skill everywhere the agents on
  this machine look: Claude Code gets a file per skill under `.claude/skills/`,
  and the agents that read `AGENTS.md` or `GEMINI.md` get a fenced section per
  skill — the existing plans fence keeps its bare spelling, so nothing already
  installed stops matching. The palette gains an "Open the … skill" command per
  installed skill, with the honest caveat that these copies are rewritten on
  update.

- 3c9385b: Drag a markdown file from Finder onto the window and it opens, editable, and
  saves back to where it came from. A file that lives inside an open repository
  opens as that repository's file, diff and all; one from anywhere else opens
  with its folder as its root — the watcher, autosave and the conflict check
  all work, because they only ever needed a directory and a name. Its view
  switch offers Write and Source and no Diff, since there is no commit to
  compare against. A dropped folder is the add-a-repository gesture by other
  means; anything that isn't markdown is declined by name.

  This turns Tauri's own drag-drop handling on, which is what makes real
  filesystem paths — and therefore editing in place — possible at all.

- 3c9385b: Shortcuts now live in one registry instead of twice — once as a hand-written
  `else if` chain and once as strings in the palette that agreed only because
  someone kept them agreeing. The unconditional bindings moved into a keymap
  table; the keydown handler is a lookup over it, and the palette renders its
  key hints from it, so a hint can no longer lie about a key you have rebound.

  ⌘/ opens the new shortcut sheet: every binding, grouped, drawn from the
  registry. Click one and press the new keys to rebind it — overrides merge
  over the defaults in settings the way settings already merge, ⌫ unbinds, and
  a conflict with another binding is refused by name rather than silently
  letting one command win. Contextual keys — Escape, ⌘B while writing, ⌘+/− by
  focus — stay hand-written, and the sheet says so instead of pretending.

- bff9d19: The view switch is one global state: Write, Source and Diff set both panes
  at once — and ⌥-click (or the palette's "This pane" commands) pins only the
  focused pane, so the same file can sit rich on one side and raw on the
  other. When both panes hold one file they mirror instantly: the pane being
  typed in owns the buffer and the save, the raw views follow per keystroke,
  the built page follows on a short trailing debounce, and the other pane's
  autosave is adopted quietly instead of rebuilding the reader's view.

  The pointing routes filled in: right-click a file in the tree for "Open to
  the side", right-click a tab in either strip to move it across or close it.
  The drop zone stays away once a split exists (the pane itself is the target
  — nothing promises a third pane), a drag from the split outlines the main
  pane as its target the way the split is outlined for drags the other way,
  and the bright active-tab indicator follows the pane the keystrokes actually
  go to.

- d6cb936: Two agents can work at the same time, and moving between conversations no
  longer kills one.

  A session was keyed by repository, so there was one by construction. Changing
  chat meant changing which conversation that single session was having — which it
  cannot — so it was ended instead. Setting an agent going on a long job and
  reading another conversation while it worked was not something you could do.

  A session is now keyed by the conversation it is having. What ends one is
  deleting the chat, clearing it, or quitting; navigating does not. Every event
  the agent produces names its conversation, so an answer arriving for a chat you
  are not looking at lands in that chat's transcript rather than being dropped —
  which is what used to happen, permanently, including after switching back.

  Everything that was one-per-repository followed:

  - The turn in flight is per conversation, so a long job in one does not disable
    the composer in another, and Stop belongs to the chat it is in.
  - Permission requests are asked and answered per conversation. Their ids now
    carry the chat, because a tool call id is only unique within its own session
    and two sessions in one repository could mint the same one — answering in one
    chat could have resolved the other's question.
  - Context and cost are read per conversation. Two sessions were overwriting each
    other's reading, so the status bar showed whichever spoke last under a label
    saying it was the repository's.
  - The conversation picker puts running chats first, under their own rule, and
    the rail carries a count of how many agents are working — across every
    repository, since what that number is about is processes on the machine.

- 3c9385b: The bundled skills work without being installed anywhere. Type `/plans` or
  `/review` in the agent chat and the skill's text travels with your message —
  the transcript keeps what you typed, the agent gets the conventions, and no
  repository grows a file for it. The app also keeps fresh copies in
  `~/.plans/skills/` on every launch, one folder per skill, for pointing other
  tools at. Installing into a repository stays what it was: a button you can
  press, never something that happens to you.
- 3c9385b: Two documents, side by side. Drag a file — from the tree or from the tab
  strip — onto the dashed "Open beside" zone along the page's far edge and it
  opens beside the one you are reading. Once a split is open the zone stays
  away — the pane itself is the target, outlined under the drag, so nothing
  ever promises a third pane; a drop there retargets it. The tab row itself splits: each pane carries its
  own strip and its own header — path, status badge, owner, due — sized to its
  pane. Tabs move rather than copy: dragging the open document to the side
  lets the next tab fill its place (or the blank state show), a split tab
  dropped on the main pane comes back, and tabs reorder live under the pointer
  within a strip. ⌃Tab cycles the focused pane's own strip.

  The split's header carries a Frontmatter button, like the main one — no
  close button: the pane closes from the palette ("Close the split") or when
  its last tab does. "Swap the panes" trades the two tab sets wholesale, and
  "Open this document in both panes" puts two live views on one file — a save
  in one is the other's outside edit, taken silently when clean and raised as
  the conflict bar when both have typed. There is one view switch, in the chrome, and it acts on whichever pane
  has focus; the split offers Write and Source, and no Diff. ⌘\ does the same from the keyboard, opening the
  most recent other buffer in a second pane — its own view, its own scroll, its own save machinery against
  its own stamp, so a save in one pane can never use the other's. ⌘⌥\ turns
  the split the other way, ⌘⌥1/⌘⌥2 move focus between panes (the bare digits
  stay the view switch), and ⌘W closes the focused split before it closes
  buffers. The divider drags, double-click evens it out, and the split — which
  way it runs, where the divider sits, what it shows — survives a restart.

  Opening a file while the split has focus loads it there; a file already open
  in the other pane moves focus instead of opening a second copy, because two
  editors saving one file against two stamps is the conflict machinery firing
  on the app's own edits. Zen collapses to one pane and restores the split on
  the way out. Two panes and no more, deliberately.

### Patch Changes

- d6cb936: Fixes a running agent going silent after another session was stopped.

  `agent-down` is emitted twice for one stop, and has to be: the session is told
  to go and says so at once, so the panel is not left waiting on a process that is
  already unreachable, and the session's own task says so again when it has
  actually finished — which is arbitrarily later, because telling a session to
  stop only queues the message.

  With nothing to tell the two apart, that second farewell was indistinguishable
  from news about whatever was running by then. Stop a session, start another, and
  the first one's goodbye cleared the second one's turn — after which the live
  agent's answer went nowhere, which looks exactly like an agent that has nothing
  to say. Every session now carries a number, and a message about a session older
  than the one in hand is a message about something already over.

  Found while specifying `plans/several-agents-at-once.md`: the refactor needs
  events to say which session they belong to, and asking that question turned up a
  case where the answer already mattered.

- d6cb936: Naming a new file now leaves the cursor in it, in the empty line under the
  heading. Creating a file used to leave you looking at it rather than writing in
  it, so the first thing you did after making one was click into it.

  The cursor is asked for, not placed. Opening a file only requests the state
  change that leads to the editor swapping its document, so focusing at the point
  of asking lands in the file you were reading before — which the swap then throws
  away. The request is left for the editor and honoured once the new document has
  settled, including on the path where the file is the first one opened and the
  editor is being built for it rather than swapping.

  Only creating a file does this. Clicking through the tree to read something
  still leaves the cursor where it was.

- d6cb936: A new plan is created with `status:` frontmatter already in it, using the first
  word of your configured status vocabulary.

  Until a plan has a status it is invisible to everything that reads one — the
  tinted dot in the tree, the status filter, and now the ordering — so a file made
  in the app did not look like a plan to the app until somebody remembered to say
  so. Writing it at creation means it is a plan from its first save.

  The word comes from settings rather than being baked in, because the vocabulary
  is a convention the repository keeps rather than one the app owns.

- d6cb936: A file can be dragged from one repository into another. The tree refused it
  before, on the grounds that it would be a copy rather than a move — which was
  true, and is the answer rather than the objection: git has no rename spanning
  two repositories, so the destination gets an addition and the original stays
  exactly where it was. The cursor says which of the two a drag is while you are
  doing it.

  The buffer is written out first. The file being dragged may be the one you are
  typing into, and the copy happens on disk — without that, what arrives in the
  other repository is quietly a few seconds old.

  This is the half of "copying files between repos, and dropping files in from
  Finder" that costs nothing. The Finder half is a different change: it needs
  Tauri's own file-drop handling turned on, which takes away the HTML5 drag
  events this feature and the tree's drag-to-move are both built on.

- d6cb936: The file tree can be ordered by `status:` rather than by name — "Order files
  by" in Settings, or from the palette. Within each folder, since a sequence
  across unrelated folders means nothing.

  This is the cheap answer to wanting a plans folder in some order other than the
  alphabet, and it was worth trying before adding a field for it: the status is
  already read from every file during the walk, so it costs a comparison rather
  than a number to keep in step by hand — and unlike a number, it cannot drift out
  of step with itself when you insert a plan in the middle.

  The vocabulary is the one already in Settings, so "first" means first in your
  list. A file with an unrecognised status, or none at all, comes last, which
  means adopting this can be partial — most repositories hold files that are not
  plans.

- d6cb936: The palette can now put a zoomed page or sidebar back to its default size.

  Nudging was the only way these values moved, so having zoomed you could only
  return by counting your way back — to a number that is written down nowhere you
  can see while the palette is open. The Settings page has had the answer all
  along: every slider there carries a revert. The palette now offers the same for
  any nudged value — the page, the tree, line length, line height, code size —
  showing what it would move from and to.

  "Zoom" also finds the size commands now, which is the word people reach for and
  the one that used to find nothing at all.

- d6cb936: Fixes a file growing a second, empty frontmatter block in front of its real
  one — `---`, blank, `---`, then the actual metadata. Only the first block
  parses as frontmatter, so the plan's status became invisible to the app while
  the file still looked almost right on disk.

  Emptying the frontmatter sheet's textarea hands back an empty string, and an
  empty string is not the same thing as no frontmatter: `null` means the file has
  no block, `""` means the block is there and holds nothing. The join treated
  only the first as "write nothing", so the second wrote a bare pair of fences.
  A block holding nothing is now no block at all, checked before the
  write-it-back-verbatim path so that a file already carrying an empty block is
  repaired by saving it rather than having it preserved.

- d6cb936: `#` in the palette can now reach every open repository's conversations, not only
  the one you are in. It is a setting rather than a change: the list following the
  focused repository is the list being right for most work, so that stays the
  default, and "every repository" is there for the other habit — one train of
  thought that outlives which window happens to be focused.

  A foreign chat is labelled with the repository it belongs to, since chat titles
  come from what was said and two repositories can easily hold one called the same
  thing. Opening it goes there: a transcript is keyed by its repository, the agent
  runs in it, and the plans it is about are there, so the window follows.

  Reading the list leaves nothing behind. The index-loading the panel does invents
  and writes an empty conversation when a repository has none, which is right for
  the repository being worked in and would otherwise seed a stray "New chat" in
  every repository you have ever opened.

- d6cb936: "Install skill" wrote `.claude/skills/plans/SKILL.md` — Claude Code's location
  and nobody else's. The chat starts Codex, Gemini and OpenCode just as readily,
  and none of them will ever read that file, so for three of the four agents the
  button was a no-op with a reassuring label.

  The conventions now go wherever the agents on this machine actually look:
  Codex and OpenCode read `AGENTS.md`, Gemini reads `GEMINI.md`, Claude Code
  reads its skills directory. One text, a table of addresses — the conventions
  are the same conventions whoever is reading them. Only for agents this machine
  has, since a `GEMINI.md` arriving in the git status of someone who has never run
  Gemini is litter.

  A repository that already has an `AGENTS.md` does not lose what was in it. A
  file under a tool's own dotted directory exists because the tool does, so the
  app owns it and replaces it; a file at the root of the repository belongs to the
  repository, and only the app's own fenced section is rewritten.

  The settings row names the agents rather than a path, which is the part of this
  the reader can actually act on.

- d6cb936: ⌃Tab steps to the next open buffer and ⌃⇧Tab to the previous one, wrapping at
  both ends — the binding every tabbed application has. Both are in the palette
  too, since a binding nobody can find is a binding nobody uses.

  ⌘⌥←/→ did this already and now shares the same code, which fixed something the
  two had quietly disagreed about: cycling onto a memory buffer — the release
  notes, say — tried to read a file that was never on disk.

- d6cb936: Mermaid diagrams zoom and pan. ⌘- or ctrl-scroll — which is also what a trackpad
  pinch arrives as — zooms about the pointer, dragging moves the picture once
  there is somewhere to move it, and double-clicking or the `1:1` chip in the
  corner puts it back. A plain scroll still scrolls the document, since the
  pointer is over a diagram for much of a long plan.

  The zoom is remembered outside the widget rather than on it. ProseMirror keys
  the diagram's widget by position, so typing a paragraph anywhere above one
  rebuilds it — anything held on the node would be thrown away by an edit
  elsewhere in the file.

  The figure now clips at its frame. At 1:1 that changes nothing, because the
  diagram is scaled to the width; zoomed, being cut off at the frame is the point.

  A diagram can also be maximised, from the ⤢ in its corner — the same picture
  with the room to read it, since zooming inside a frame the size of a paragraph
  is the wrong size for the diagrams that most need looking at. Escape or the
  backdrop closes it. The maximised view is built outside the editor entirely,
  because the figure clips its overflow and anything inside the editor's DOM is
  something ProseMirror believes it owns.

  The `1:1` and maximise controls read as buttons in the document, not only in
  the maximised view. Milkdown's own stylesheet strips the border and background
  off any button inside the editor, and it does so with a selector that outranks
  a plain class — so the same control looked like a button in one place and like
  bare text in the other.

- 3c9385b: Six from the open bug list:

  - Long paths in the git panel no longer push the filename out of view — the
    name never gives way; the folder path is what truncates, from the front, so
    the nearest folder survives.
  - "Refresh branches" in the git commands re-reads the branch list on demand.
  - Right-click a repository in the tree → "Open in Terminal".
  - Links between markdown documents work: ⌘-click a relative link and the
    other file opens in the app; anything with a scheme opens in the browser.
    A plain click stays an editing click, and the webview never navigates away.
  - Escape stops the agent mid-answer, matching the Stop button.
  - Long documents show a thin scrollbar in the paper's own colours, and the
    scroll position is remembered per buffer — jumping between two documents no
    longer resets both to the top.

- d6cb936: A file open in another tab that changes on disk now says so, with a dot beside
  its name in the tab row.

  Only the active file was ever checked for outside edits, so a plan rewritten by
  an agent or by a `git checkout` sat there unremarked until you happened to click
  back to it — which is the worst moment to be told, since the change is old by
  then. A background tab holds no text and re-reads from disk when you open it, so
  there was never anything to reload; what was missing was only the telling.

  The check runs on the slow tick rather than the watch interval, for the same
  reason the tree walk is staggered: a `stat` per open tab is cheap but not free,
  and none of this is urgent.

## 0.4.1

### Patch Changes

- f9bb39b: A long chat name is truncated rather than wrapped — the title is the first
  thing you said, so it is a sentence, and a sentence in a fixed-height bar wraps
  out of it and over the row below.

  The chat panel has a wider floor: it cannot be dragged narrower than the
  pickers, the title and the composer need to sit beside each other.

  The chat opens beside the page rather than under it. A conversation is read
  down, so height is what it wants — and the plan stays fully visible next to it.

- 32749a9: Fixes the agent failing with "env: node: No such file or directory" when the
  app is launched from Finder. Resolving `npx` to an absolute path was only half
  the job — `npx` is a script whose shebang runs `env node`, and `env` searches
  the _child's_ PATH, which was launchd's. The agent is now started with the PATH
  your shell would give it.

  A launch failure no longer suggests signing in. An agent that never started and
  one that is signed out look nothing alike and need opposite advice.

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
