---
status: done
---
# Branch Search

We should be able to search through the list of branches. The seed is one
sentence because the pain is one sentence: on a repository with real history
the branch picker is a scroll, and a scroll through two hundred names is not
how anyone finds `plans/settings-json`. Especially not in this app's own
world, where the factory mints a branch per plan — the naming convention we
adopted guarantees the list grows, and guarantees every name shares a prefix,
which is precisely the shape the current picker is worst at.

## Two doors, one already half-open

Branches reach the screen through two doors, and neither searches well:

- **The rail's dropdown** (`App.tsx:3922-3935`) is the app's own `Dropdown`,
  whose typing behaviour is a native select's type-ahead — a prefix match
  against the label, jumping the selection (`Dropdown.tsx:112-119`). Prefix
  matching is exactly wrong for branch names: typing `settings` finds nothing
  in a list where everything begins `plans/`, and the 700ms buffer means a
  hesitation starts you over.
- **The palette** already lists a `Switch to X` command per branch
  (`App.tsx:3410-3416`), and palette commands go through real subsequence
  scoring (`Palette.tsx:158`, scored over group and label at
  `Palette.tsx:911`). So `>settings` genuinely finds the branch today — the
  feature the seed asks for half-exists, in the door people do not think of
  as the branch door.

That second point disciplines the plan. The palette path needs no new search;
it needs to stay correct as the list grows. The dropdown is where the work is,
because it is where someone *looking at the branch name in the rail* goes to
change it, and no palette will retrain that instinct.

## Every dropdown learns this, not just the branch one

The branch list is the worst case, not a special case. The app has one
`Dropdown` and seven call sites, and several of them hold lists that grow
without the app's permission: the folder pickers in the move and new-file
sheets list every folder in the repository (`MoveSheet.tsx:50`,
`NameSheet.tsx:77`), the chat picker grows with every conversation the
factory or a person starts (`ChatPanel.tsx:721`), and the agent's own config
options are whatever an agent advertises — a model list is already a dozen
rows and is not ours to cap (`AgentOptions.tsx:72`). Building search into a
bespoke branch picker would fix one list and leave the same scroll waiting in
four other menus. So the design lands in `Dropdown` itself: any list that
*could* be long gets search, because the component cannot know which ones
will be.

When the menu opens with a long list, it gains a filter field at its top.
Typing filters the choices by the same subsequence scorer the palette uses —
extracted from `Palette.tsx:158` into a shared module, because two fuzzy
matchers that rank differently would make the same query find different
things in different corners of one app. Arrows and Enter work on the
filtered list exactly as they do now; Escape with a non-empty filter clears
it, Escape with an empty one closes the menu — the two-step back-out the app
already practises elsewhere.

The filter appears by threshold, decided by the component from
`choices.length`, not by a prop the call sites opt into: a filter input on a
three-theme dropdown is chrome without a job, and the type-ahead a real
select taught everyone (`Dropdown.tsx:113`) is still the right thing at that
size. Above the threshold the type-ahead's job is taken over entirely by the
filter — one text entry, one meaning. No call site changes for this; that is
the point. A repository with three folders shows a plain menu, and the same
sheet over a repository with forty shows a searchable one.

The alternative — reaching for the palette component inside the rail — was
considered and declined: the palette is a modal over the whole window with
file/command/chat modes woven in (`Palette.tsx`), and what these menus need
is filtering, not a second palette with most of itself amputated. One nuance
the generalisation adds: filtering must respect rows the menu treats
specially — the `apart` rows like "Add a repository…" (`Dropdown.tsx:16`,
`App.tsx:3918`) are actions, not choices, and should stay visible under
their rule regardless of the query rather than being scored like content.

## The list behind the search

Searching a list sharpens questions the scroll let us ignore:

- **Latency.** Branches load lazily and are measured at over three seconds on
  a large repository (`App.tsx:1152-1156`) — acceptable when the menu was a
  glance, corrosive when someone opens it *to type*. The menu should show the
  stale list immediately (it already falls back to the current branch alone,
  `App.tsx:3931`) with a quiet refreshing note, rather than an empty box that
  fills when git gets around to it. The lazy fetch itself stays: fetching on
  `onOpen` (`App.tsx:3925`) was the right call and search does not change it.
- **Local only.** `git_branches` lists local heads (`lib.rs:1321`,
  `git branch --format=%(refname:short)`). Half the time the branch being
  searched for is a colleague's — or the factory's — and exists only on
  origin. Searching a list that silently lacks it is worse than the scroll,
  because an empty result reads as "does not exist". Include remote branches,
  set apart the way the dropdown already sets apart its odd rows
  (`apart`, `Dropdown.tsx:16`), with checkout doing the usual
  create-tracking-branch dance. This doubles the value of the feature for one
  extra `git` flag and one decision in `git_checkout` (`lib.rs:1336`).
- **Ordering.** Today the list is git's default, alphabetical-ish. Once there
  is a scorer, an empty filter can rank by recency (`--sort=-committerdate`)
  — the branch you want is overwhelmingly one you or the factory touched this
  week — and a non-empty filter ranks by match score. Alphabetical survives
  nowhere, and is missed nowhere.

## Open questions

- Does the palette's per-branch command list scale, or should it become a `>`
  mode of its own? Two hundred `Switch to X` rows are scored on every palette
  keystroke (`App.tsx:3410`, rebuilt in a `useMemo` over `branches`) — cheap
  enough today, but the moment it isn't, branches may deserve the treatment
  chats got with `#` (`Palette.tsx:557`).
- Deleting branches: a searchable list is where people will first *see* their
  branch clutter, and the app offers no way to act on it. Out of scope here,
  but the first feature request this one generates.
- The threshold number — eight, twelve? Worth choosing by feel in review
  rather than argued in advance.
- Should the filter also match against the branch's last commit subject?
  `%(refname:short)` is all we fetch; one more format field would let
  `settings` find a branch named after a ticket number. Leaning no for the
  first cut — names are the contract this repo's own convention keeps.

## Next

- [x] Extract the subsequence scorer from `Palette.tsx:158` into a shared
      module; palette and dropdown both import it
- [x] `Dropdown` grows a filter row above the choices, on by threshold from
      `choices.length` — no call-site changes; filter-aware keyboard
      handling, two-step Escape, action rows exempt from scoring
- [x] Check each call site inherits sensibly: branches, repos, folders
      (`MoveSheet.tsx:50`, `NameSheet.tsx:77`), chats (`ChatPanel.tsx:721`),
      agent options (`AgentOptions.tsx:72`)
- [x] Show the stale branch list with a refreshing note while the lazy fetch
      runs
- [x] `git_branches` gains remotes (deduped against local, set `apart`) and
      recency ordering; `git_checkout` learns to create a tracking branch
- [x] Decide the threshold, by feel, across the call sites it will actually
      bite

## What the building decided

- **Ten.** Below it a menu is a glance and the select's type-ahead is right;
  at ten the branch list, a repository's folders and an agent's model list are
  all already past it, and three papers are nowhere near. `FILTER_AT` in
  `Dropdown.tsx`, exported so a test can say the number out loud.
- **`apart` was doing two jobs.** The plan said `apart` rows are actions and
  should be exempt from scoring, and also that remote branches should be
  `apart` — but remote branches are content, and exempting two hundred of them
  from the filter would defeat the search. So the two meanings were split:
  `apart` is the rule that separates a group, `always` is the row that survives
  a query. "Add a repository…" is both; a remote branch is only the first.
  Under a filter the `apart` rows sort to the foot so their rule still
  separates a group rather than falling between two arbitrary rows.
- **The move sheet had to be told.** It cancels on Escape and moves on Enter
  from a capture-phase window listener, which would have eaten the filter's own
  keys; it now stands back while a dropdown is open (`MoveSheet.tsx:29`).
