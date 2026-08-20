---
status: done
---
# A Review Skill: PR Review Materials, Written For Reading

Reviewing pull requests is THE hero use case of this app. The pieces are all
here already — an agent that can read the diff, a folder of markdown the app
renders beautifully, mermaid for pictures, a tree that reads as a board — and
nothing that tells the agent how to use them *for a review*. Ask today and you
get one massive document, because nobody said otherwise. This plan is the
saying otherwise: a skill that ships with the app and teaches any agent how to
turn a branch into review materials a human can actually digest.

## A second skill, and what that breaks

The app ships exactly one skill, and the machinery knows it. The conventions
are imported at build time from the single canonical file
(`src/skill.ts:2`, `skills/plans/SKILL.md`), folded into one fenced section
(`src/skill.ts:46` — `<!-- plans:begin -->` / `<!-- plans:end -->`), and
written to each agent's own lookup path from the table in
`discover.rs` (`src-tauri/src/agent/discover.rs:103`, the `conventions` field).
Every part of `skillState` and `installConventions` (`src/skill.ts:85`,
`src/skill.ts:104`) iterates over *paths*, never over *skills* — one text,
several addresses.

A review skill is a second text, and the two destinations age differently:

- **Claude Code** reads a directory of skills, so a second one is simply a
  second file — `.claude/skills/review/SKILL.md` beside the existing
  `.claude/skills/plans/SKILL.md` (`src/skill.ts:16`). No merging, the app
  owns the whole file, done.
- **The `AGENTS.md` agents** (Codex, OpenCode — `discover.rs:133`,
  `discover.rs:155`) and `GEMINI.md` get everything appended into one
  repository-owned file, fenced. Two skills in one file means the fence needs
  a name: `<!-- plans:begin review -->`, with the bare `<!-- plans:begin -->`
  kept as the plans section's spelling so existing installs still match. The
  merge in `src/skill.ts:51` matches on markers, not content, precisely so
  reworded sections are still found — the same property carries a named fence
  with no new ideas.

So the refactor is: `skill.ts` grows a small table of bundled skills
(`{ name, text, fenceName }`), and `skillState` / `installConventions` answer
across skills × paths the way they already answer across paths. The button in
Settings stays one button (`SettingsPage.tsx:594`) — "Install conventions"
meaning *all* of them, because a repository with the plans conventions and no
review skill has not had the conventions installed, which is the same argument
`skillState` already makes about a repo where one agent's copy is missing
(`src/skill.ts:83`).

One thing not to do: a per-skill install UI. Nobody wants to curate which
conventions their agent has; they want the agent to know how to work here.

## What the skill actually says

The skill is the product; the plumbing above is delivery. Its content, argued
rather than listed:

**Split by what the reader does, not by what the diff contains.** One massive
document is the failure mode the seed names. The skill should prescribe a
small, ordered set — an overview that says what the change *is* and why, then
one document per area of understanding (not per file: files are the diff's
unit, not the reader's), then a closing document of risks, questions, and
what to test. Ordered, because review is a guided read: number the files
(`review/01-overview.md`, `02-…`) so the tree's alphabetical order *is* the
reading order. They live under the repo's plans folder so the app lists them
and the frontmatter `status` colours them — a review doc marked `ready` is one
the agent has finished writing, and flipping it to `done` as you read is a
checklist the board gives us for free.

**Pictures where prose loses.** The app renders ```mermaid blocks inline and
full-screen (`src/mermaid-view.ts:86`, rendered at `mermaid-view.ts:119`), so
diagrams cost the reader nothing. The skill should say *which* diagram earns
its place: flowcharts for control flow that changed, sequence diagrams for new
call paths across boundaries, state diagrams where a lifecycle moved. Mermaid
also does Gantt, pies, quadrants, requirement diagrams and more — the skill
should mention the breadth once and then warn against it: a pie chart in a PR
review is decoration. One diagram that explains the shape of the change beats
four that inventory it.

**Code blocks are quotations, not mirrors.** Snippets carry the few lines a
reader must actually understand — the new invariant, the subtle condition —
with `file:line` beside them so the claim is checkable, exactly the register
this folder already writes plans in. The skill should say plainly: never paste
whole files; the diff already exists, the review explains it.

**Ground every claim in the checkout.** The agent reviews the working tree and
the branch's diff against its base — which it can get itself, since it runs in
the repo. The skill tells it to cite what it read, and to write "I did not
look at X" rather than reviewing X from imagination.

## Getting to it, and managing it

The seed asks two adjacent questions that are scoped here deliberately:

- **Open PRs in the palette or git panel.** The app's git layer is local — the
  whole surface in `api.ts:220-257` is status, diff, branches, push, pull;
  there is no forge in it, and `GitPanel.tsx` has no notion of a PR. Listing
  open PRs means `gh` or a forge API, auth, and a second identity to manage.
  That is a real feature and a separate plan; bolting it onto this one would
  hold the skill hostage to an integration. What *this* plan can do cheaply:
  the review skill instructs the agent to start from a branch or PR number the
  human names in chat, which is how the handoff prompt already passes context
  (`src/agent.ts:16`).
- **Managing installed skills.** The installed copies are ordinary
  repo-relative markdown, which means the app can already open them — they are
  files in the tree's repository, readable by `readPlan` like anything else.
  So "manage" is a palette command per installed skill ("Open review skill"),
  not a management screen. The one honest caveat the command's hint should
  carry: app-owned copies (`src/skill.ts:33`) are replaced wholesale on
  update, and fenced sections are rewritten — edits belong in the repo's *own*
  prose around the fence, or upstream in this repo's `skills/` folder. Editing
  the installed copy is writing in sand, and the UI should say so rather than
  let the overwrite be a surprise.

## Open questions

- Where do review docs go — `plans/reviews/<branch>/` as a convention in the
  skill, or wherever the human says? A fixed spot makes the palette's `#`-like
  affordances possible later; a convention the human never asked for is also
  how folders rot. The skill can *default* and defer.
- Does the review skill install everywhere the plans conventions do, or only
  when asked? One button says everywhere; the counterargument is repos where
  the user never reviews. Leaning everywhere — the text is small and inert.
- The named-fence change touches files the *repository* owns (`AGENTS.md`).
  Is appending a second fenced section to a file someone hand-tends polite
  enough, or should both app sections share one fence to keep our footprint
  to a single block?
- Should the skill teach a size threshold — below N files changed, one
  document is right and splitting is ceremony?

## Next

- [x] Write `skills/review/SKILL.md`: the document split and ordering, the
      mermaid guidance (breadth noted, restraint prescribed), quotation-style
      code blocks with `file:line`, statuses on review docs — plus the size
      threshold (roughly five files / one area → one document)
- [x] Generalise `skill.ts` from one text to a table of bundled skills; named
      fences, bare fence kept for the existing plans section
- [x] `skillState` / `installConventions` answer across skills × paths; the
      Settings button stays one button, its hint updated to say what it now
      installs
- [x] Palette commands to open each installed skill file, with the
      overwrite-on-update caveat in the hint
- [x] A separate plan for forge/PR integration — seeded as
      `plans/forge-pr-integration.md`, status draft
