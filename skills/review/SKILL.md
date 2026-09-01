---
name: review
description: How to turn a branch or PR into review materials the Looped Plans app renders well - a small ordered set of documents, diagrams where prose loses, code blocks as quotations. Use when asked to review a branch, a pull request, or a diff in a repository with a plans/ folder.
---
# Writing a review a human can read

You are reviewing a change so that a person can review it faster. The output
is a small, ordered set of markdown files the Looped Plans app renders as pages,
with a tree that reads as a board. Split by what the *reader* does; the
diff's own boundaries are the wrong unit.

The prose in every review document follows the writing skill
(`.claude/skills/writing/SKILL.md`, or `skills/writing/SKILL.md` in this
repository). Read it before writing; it sets the voice for everything a
human reads in the app.

## Where the documents go

Default to `.reviews/<branch>/` (slashes in the branch name become `-`),
unless the human names somewhere else. Number the files so the tree's
alphabetical order *is* the reading order:

```
plans/reviews/my-branch/
  01-overview.md
  02-<area>.md
  03-<area>.md
  09-risks-and-questions.md
```

Each file carries frontmatter with a status, like any plan:

- Write each document, then mark it `ready`. A review doc marked `ready` is
  one you have finished writing.
- The reader flips docs to `done` as they read; that checklist belongs to
  them. Never set `done` yourself unless explicitly asked to.

## The split

- **01-overview** - what the change *is* and *why*, in a page: intent, shape
  and the areas the rest of the review walks through, in order.
- **One document per area of understanding.** Files are the diff's unit; the
  reader's unit is "the new save path" or "how auth changed". A document per
  area explains the before, the after and the reason.
- **The closing document** - risks, open questions and what to test. This is
  the document the reader acts on; nothing in it should appear for the first
  time here without a pointer back to the area that explains it.

**Size threshold:** below roughly five changed files, or one area of
understanding, one document is right and splitting is ceremony. Write the
overview and the risks as sections of a single file instead.

## Pictures where prose loses

The app renders ```mermaid blocks inline and full-screen, so a diagram costs
the reader nothing. Use one where prose loses:

- **flowchart** for control flow that changed
- **sequenceDiagram** for a new call path across a boundary
- **stateDiagram** where a lifecycle moved

Mermaid also does Gantt, pie, quadrant, requirement diagrams and more. Know
the breadth, but reach for it only where it earns its place; a pie chart in
a PR review is decoration. One diagram that explains the shape of the change
beats four that inventory it.

## Code blocks are quotations

A snippet carries the few lines the reader must actually understand - the new
invariant, the subtle condition - with `file:line` beside it so the claim is
checkable. Never paste whole files; the diff already exists, and the review's
job is to explain it.

## Ground every claim in the checkout

You are in the repository. Review the working tree and the branch's diff
against its base - get the diff yourself (`git diff <base>...`, or from the
PR number or branch the human names in chat). Cite what you read. If you did
not look at something, write "I did not look at X" rather than reviewing X
from imagination.

## Writing style

This is technical writing. Assume the reader has little to no context on the
feature being implemented or the bug being fixed. Your job is to give them
that context in a way that is simple to understand and quick to consume.
