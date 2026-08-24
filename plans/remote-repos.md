---
status: draft
---
# Remote repos

We need a feature which lets us point at remote repos instead of local ones —
watch markdown files in some remote location, review from a phone, create new
plans from a phone. The original sketch asked: is this a mode that monitors a
remote repo *without* maintaining a local clone?

## The clone question answers itself

No clone means no app. Every backend command is `git -C <repo>` plus a
filesystem path (`git()`, `lib.rs:52`): the tree is a directory walk
(`list_plans`, `lib.rs:355`), reading is `read_plan` against a file on disk
(`lib.rs:407`), writing is a stamped write to that file (`write_plan`,
`lib.rs:622`), the diff is `git show HEAD:` against the working copy, search
greps the checkout, and the agents are child processes whose working
directory *is* the repository. A clone-less mode would mean re-implementing
that entire surface against a forge API — GitHub only, rate-limited, with no
search, no diff-as-you-type, no agents — a second app wearing the first one's
clothes.

The worker already faced this exact question and answered it: it takes URLs
in its config and maintains its own clones under `~/.plans-worker/`
(`worker.mjs:93–101` — clone once, then `fetch origin --prune` and a hard
checkout of the default branch every pass). So "remote repo" should not mean
"no clone"; it should mean **the app owns the clone**. The user hands over a
URL instead of a directory, the checkout lives in the app's own corner
(`~/.plans/repos/<name>`), and every existing feature works untouched,
because downstream of `open_repo` (`lib.rs:169`) a repository was only ever a
path. The feature is one new command — `clone_repo(url) → path` — and a
policy for keeping that path fresh; it is not a mode.

## What "managed" changes

The difference between a repo you opened and a repo the app cloned is who is
responsible for sync, and that is the whole design.

**Reading: fetch on the poll, fast-forward when clean.** The watch loop
already ticks every `watchSeconds` and does the expensive work every sixth
tick (`SLOW`, `App.tsx:838`; the interval at `App.tsx:842`). A managed repo
adds `git fetch` on that slow tick — the plumbing exists as `git_fetch`
(`lib.rs:1232`) — and, when the working tree is clean and the branch is
simply behind, fast-forwards; the file poll then notices the changed files
the way it notices any outside writer, which is the app's founding
assumption ("Files written by Claude Code in a terminal should turn up on
their own", `App.tsx:840`). Behind-ness is already measured and typed
(`ahead`/`behind` on `GitStatus`, `api.ts:33–34`), so the rail can show
"syncing" honestly rather than pretending the remote is live. That is the
"fast and refreshes frequently enough" requirement made concrete: freshness
is `watchSeconds × SLOW`, a dial the user already owns.

**Writing: the branch-or-main question belongs to publish, not to save.**
Saving stays local and instant — the stamp machinery (`expect_stamp`,
`lib.rs:626`) already protects against the fetch racing an edit, and an edit
should never wait on a network. The prompt the sketch asked for happens at
the moment the edit wants to leave the machine: commit to the default branch
and push, or create a branch and push that. Both arms are shipped plumbing —
`git_commit` (`lib.rs:1138`), `git_push` (`lib.rs:1146`),
`git_create_branch` (`lib.rs:1222`) — so the feature is a small sheet over
the git panel, not new git. Asked once per repo, remembered as its publish
policy, changeable in the panel; plans repos will pick main, code repos will
pick branches, and the worker's own rule ("the default branch takes `plans/`
changes only") suggests the default: main for files under a plans dir, a
branch for anything else.

**Auto-publish is what makes it feel remote.** With a policy chosen, a
managed repo can commit-and-push on the same debounce that autosaves —
otherwise "remote" degrades to "local clone you must remember to push".
Un-pushed edits also pause the fast-forward (the tree is no longer clean),
so publishing promptly is what keeps reading fresh; the two policies are one
loop, and the sheet should say so.

**Never merge.** A fast-forward that cannot happen — local commits and
remote commits — is a divergence the app should display (the panel already
shows ahead/behind and refuses nothing) and let a human or an agent resolve.
The app is a reader with a pen, not a merge tool; the moment it invents
conflict resolution it starts eating files, which is the one sin the stamp
machinery exists to prevent.

## Adding one

`addRepo` is a directory picker (`App.tsx:1000`). The same flow learns to
accept a URL — paste into the same field the palette's "open" already offers,
or a second button — and routes it to `clone_repo`. From `RepoInfo` onward
nothing changes; the settings entry just carries `managed: true` so the app
knows sync is its job and that "remove" may also mean "delete the clone".
Removal should ask, and should refuse while the clone has un-pushed work.

## The phone is a different plan

The mobile ambition is real but it is not this feature. This app is a Tauri
desktop binary; a phone build is a platform port (Tauri does ship mobile
targets, but the agents, tmux (`tmux-sessions.md`) and child processes do
not follow), and "creating plans from my phone in the cloud" already has a
cheaper path: the worker dispatches `draft` plans from the origin tip
(`github-actions-agents.md`), so a plan committed from GitHub's own mobile
editor — or any web UI that can write a file to a branch — enters the
factory with no app involved. Managed clones are still the right first step:
they force the sync policy (fetch, fast-forward, publish, never merge) to be
designed and tested where it is cheap, and any future mobile client inherits
that policy rather than a pile of desktop assumptions. But the phone gets
its own plan, and it will probably be a web front end over the repo, not
this binary on a small screen.

## Open questions

- **Auth.** Clone and push are as authenticated as the user's git is —
  credential helper, SSH agent. Fine on the desktop; it means "add by URL"
  fails exactly where `git clone` would in a terminal, and the error should
  say so rather than be swallowed. Do we ever need more than "your git must
  work"?
- **Where clones live, and how big they get.** `~/.plans/repos/` versus
  Application Support; shallow (`--filter=blob:none`) versus full — the
  worker went full because agents need history; a reading app may not.
  Disk is cheap but a monorepo is not.
- **Fetch cost.** A fetch per managed repo per slow tick is a network call
  every ~30s at the defaults. Probably fine; worth measuring against the
  "saturated machine is a slow window" rule the poll already lives by
  (`App.tsx:832`).
- **Branch choice.** A managed repo tracks the remote default branch. Is
  switching branches in the git panel allowed, and does fast-forward then
  follow the checked-out branch's upstream? Simplest true version: default
  branch only, branches exist to be pushed and reviewed elsewhere.
- **Does a local repo want any of this?** Auto-fetch and the behind badge
  would serve ordinary opened repos too. Maybe "managed" is only about who
  owns the directory, and the sync loop is a per-repo setting either kind
  can turn on.

## Next

- [ ] `clone_repo(url) → path` in Rust — clone under the app's directory,
      then delegate to `open_repo` (`lib.rs:169`)
- [ ] Add-by-URL in the add-repo flow (`App.tsx:1000`) and `managed: true`
      on the stored repo entry
- [ ] Fetch + clean fast-forward for managed repos on the slow tick
      (`App.tsx:838–854`), with a sync indicator in the rail off
      `ahead`/`behind`
- [ ] The publish sheet: branch-or-main asked once, remembered per repo,
      commit-and-push on save debounce; wired to `git_commit` /
      `git_create_branch` / `git_push`
- [ ] Divergence surfaced, never resolved: behind+ahead shows in the panel
      and pauses fast-forward
- [ ] Removal that knows about un-pushed work before deleting a clone
- [ ] Later, separately: the phone plan — likely a web reader over the
      origin tip, feeding the worker's draft pipeline
