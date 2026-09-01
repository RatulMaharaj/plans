---
name: plans
description: Conventions for writing plan files that the Plans app reads - frontmatter, the four-status lifecycle (draft, ready, busy, done), the sections a fleshed-out plan uses, and an agent's part in it. Use when creating or updating markdown files in a plans/ folder, or when asked to flesh out, pick up, or finish a plan.
---
# Writing plans the Plans app can read

The markdown files in `plans/` pass between a human and agents. The human
writes a seed: a problem, an intent, a rough shape. An agent fleshes it out
into something buildable, and a session implements it. The Plans app is where
the human reads all of this. It renders each file as a page, shows the
frontmatter as a panel and colours the `status` key so the tree reads as a
board. Your job when touching these files is to keep that board truthful.

The prose itself follows the writing skill (`.claude/skills/writing/SKILL.md`,
or `skills/writing/SKILL.md` in this repository). Read it before fleshing out
or rewriting a plan; it sets the voice for everything a human reads in the
app.

## Frontmatter

Every plan starts with a YAML frontmatter block holding at least a status:

```markdown
---
status: draft
---

# The Plan's Title
```

Rules the app relies on:

- Exactly one frontmatter block, at the very top. Never add a second.
- Keys are simple `key: value` lines. Keep existing keys and their spelling;
  edit values in place.
- `status` is lowercase by convention. The app matches it case-insensitively
  and renders it as written.

Two optional keys route a dispatched implementation run:

```yaml
---
status: ready
model: opus
effort: high
---
```

- `model` and `effort` say which model tier picks the plan up and how long it
  may think. The values pass straight through to the invocation (e.g.
  `claude -p --model opus`), so the vocabulary belongs to whichever agent
  dispatches the plan; one agent's `opus` is another's `gpt-5.6-sol`. The
  bundled Claude Code dispatchers recognise, ranked lowest to highest,
  `model: haiku | sonnet | opus` and `effort: low | medium | high | xhigh |
  max`. A value a dispatcher does not recognise is treated as absent - it
  warns and falls back to its default rather than failing the run.
- A key that is present is respected; a key that is missing falls back to the
  dispatcher's configured default. No heuristics about what the plan "looks
  like it needs".
- The keys only bind a dispatcher. In a hand-driven session you choose your
  own model, and that is fine.

## What a fleshed-out plan looks like

A draft is whatever the human wrote down. A fleshed-out plan has a shape, so
that the human can skim any plan in the app and know where to look. These are
the sections, in this order. Include a section when the plan has something to
say in it and leave it out when it doesn't; a small plan might only need the
seed, the approach and the implementation guide.

**The seed.** Preserve the human's original text verbatim in a blockquote at
the top, under the title:

```markdown
# Reorder repositories by dragging

> would be nice to drag repo headings around to reorder them. escape should
> cancel.

...
```

The seed is the source of intent. Everything below it is your interpretation,
and keeping the original visible lets the human check that the
interpretation is faithful.

**Problem / context.** What is wrong or missing today, and any background a
session needs before it can judge the approach. Write it so a reader who
wasn't in the conversation can follow.

**Approach.** How we're going to do it and why this way. If there was a real
alternative, give it a sentence and say why it lost. Name the costs; a plan
that admits what it gives up is easier to trust.

**Implementation guide.** The heart of the plan: the steps a session would
take, with a checklist of the files that need to change and, for each, a
high-level line on what it will contain or how it changes:

```markdown
- [ ] `src/skill.ts` - add a `seed` field to the parsed plan shape
- [ ] `src/ChatPanel.tsx` - render the seed blockquote above the body
- [ ] `skills/plans/SKILL.md` - document the new section
```

Checked boxes are progress the human can see in the app while the plan is
`busy`, so an implementing session should tick them as it goes.

**Out of scope.** What this plan deliberately does not do, so a session
doesn't wander into it and the human doesn't expect it.

**Open questions.** Real decisions that are still open, addressed to whoever
moves the plan next. If a question would block implementation, say so.

Do not add a "next steps" section. The lifecycle already says whose move it
is, and the implementation guide already holds the steps; a next-steps list
on top of those is noise the human has told us they skip.

## The four statuses

Each status marks a handoff: whose move it is next.

| status | means                                                                               | next move belongs to     |
| ------ | ----------------------------------------------------------------------------------- | ------------------------ |
| draft  | The human wrote something down. It needs an agent to flesh it out into a real plan. | an agent (flesh it out)  |
| ready  | The fleshing out is done. Implementation can start.                                 | a session (implement it) |
| busy   | A session is implementing it right now.                                             | whoever set it (finish)  |
| done   | Implemented. The plan is a record now.                                              | the human (archive it)   |

One more word gets a colour of its own: `approved`. It is the human's
sign-off on a plan they have read and agreed to, and it belongs to them -
never set it yourself, and treat an `approved` plan the way you treat a
`ready` one.

Any other status renders neutral in the app; the app reads conventions rather
than owning a vocabulary. These are the shared language, so don't
invent others unless the human does.

## The lifecycle, and your part in it

```
human writes → draft → agent fleshes out → ready → session implements → busy → done
```

- **Fleshing out?** That is what `draft` is asking for. Work the human's seed
  into the shape above, keeping their intent and quoting their words in the
  seed block. When it would hold up to being implemented, set `ready`.
  Fleshing out is writing; do not start implementation from a draft.
- **Implementing?** Pick a `ready` plan. Set it to `busy` *before* you start.
  That is a claim, and it is how the human and other sessions know the file
  is being worked. One `busy` plan per session. Tick the implementation
  guide's checkboxes as you complete them. If you stop before finishing, say
  so in the plan and leave it `busy` so the claim is visible, or set it back
  to `ready` if you did not really begin.
- **Stuck?** There is no blocked status. Write what you are waiting on into
  the plan itself, loudly, at the top; a reader should not have to diff to
  find out why nothing is moving.
- **Finished?** Set `done`. Moving the file to `plans/completed/` is the
  human's call unless they've asked.
- **Never demote a status you didn't set.** A `busy` plan that isn't yours is
  someone else's session, mid-flight. Leave it alone.

## Feature folders

Related plans that describe one feature can live in a folder named for it:
`plans/feature-name/*.md`. The folder means the plans were split for
readability but describe **one unit of work** - one implementation run, one
branch, one PR - and its plans share fate. When a run needs one `model` or
`effort` for the whole folder, the highest requested value in the folder
wins, because the unit was priced by its hardest member. The only other
folders with meaning are `completed/` (archived plans) and `drafts/`.

## Editing etiquette

The app's buffer is the file on disk and it watches for outside writes, so
plain writes are safe. Keep them whole: write the full file, and don't leave
partial frontmatter or a truncated document on disk between steps.
