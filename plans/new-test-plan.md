---
status: draft
---
# A Test Plan That Closes The Honesty Gap

The suite is bigger than it looks — ten spec files, a fake backend, cargo tests
in two modules — and yet the last few bugs were found by *reading files*, not by
tests. The empty-frontmatter corruption in `agents-flesh-out-plans.md` was
"found by reading the file, not by using the app, which is the part worth
fixing: nothing surfaced it" (`BUGS.md:17`). This plan is about why the current
shape lets that happen, and what to add so it stops.

## What exists, and what it is actually for

Three layers, each with a deliberate scope:

- **Playwright against a browser**, with the Rust boundary stubbed. The whole
  strategy is stated at the top of the config: tauri-driver has no macOS
  support, so the packaged app cannot be driven, and "every failure this
  project has actually had lived in the frontend or at the IPC boundary"
  (`playwright.config.ts:5-11`). Coverage is genuinely broad: behaviour
  (`app.spec.ts`, 23 tests), performance budgets (`perf.spec.ts:66-132`),
  telemetry never leaking document content (`telemetry.spec.ts:30`),
  prettier round-trips (`roundtrip.spec.ts:107`), plus mux, agent, html,
  updates, and screenshots.
- **The fake backend** — an in-memory repository answering every command the
  app calls, installed before any app code runs (`fake-backend.ts:29`). Its
  stated point is exactly right: "not to simulate git… to make the app's own
  behaviour testable" (`fake-backend.ts:9-11`).
- **cargo tests** on the Rust side (`lib.rs:1091`, `mux.rs:249`), which cover
  parsing and path helpers, not the commands themselves.

The strategy is sound. The problem is the seams between the layers, and
`BUGS.md:37-40` already names it: "A green test proves the harness agrees with
the code, not that the app works" — with three real examples where the two
diverged (Tauri drag events, WKWebView paste, Milkdown `<br/>`).

## Gap 1: the fake is a second implementation of an unwritten contract

The fake reimplements each command by hand — `write_plan`'s stamp check
(`fake-backend.ts:84-91`) mirrors the real one (`lib.rs:589`), `rename_plan`
does files-or-folders the way `fs::rename` does (`fake-backend.ts:147-165`,
`lib.rs:640`). When the Rust side changes shape and the fake doesn't, every
frontend test keeps passing against a backend that no longer exists.

Worse, drift is *silent by design*: any command the fake doesn't know answers
`""` rather than throwing, "so a test is never derailed by something
incidental like a push" (`fake-backend.ts:240-242`). That courtesy is right
for `git_push`; it also means a typo'd command name, or a brand-new command
nobody faked, tests as a quiet success. The `generate_handler!` list
(`lib.rs:1027`) has over thirty commands; the fake handles most but not
`git_diff`, `git_stage`, `git_commit`, `git_checkout` — the whole git write
path rides the fallback.

Two cheap moves, neither of which is "simulate git":

- **A parity check, not a simulation.** A script (or a cargo test that greps
  its own `generate_handler!` block) diffs the command list against the keys
  in `fake-backend.ts` and a small allowlist of deliberately-fallback
  commands. New command with no fake and no allowlist entry → red. This turns
  silent drift into a one-line failure.
- **A `calls` audit already half exists.** The fake records every invocation
  (`fake-backend.ts:33`), and tests assert on writes with it
  (`app.spec.ts:85` — "opening a file does not write it back"). Extend the
  fallback to *record that it fell back*, and let a test assert no
  unexpected command rode it during an ordinary session.

## Gap 2: the real commands are only tested through their helpers

`cargo test` covers `safe_join` and friends, but `write_plan`'s actual
stale-stamp behaviour, `rename_plan` on a real filesystem, `create_plan`'s
exact bytes (`lib.rs:610`) — the things the fake mimics — have no tests of
their own. The empty-frontmatter bug is the cost: the suspect is
`joinFrontmatter` via `assemble` (`App.tsx:818`, per `BUGS.md:17`), a
frontend/disk interaction that no browser test can catch because the fake's
disk is a `Record<string, string>` that faithfully stores whatever it is
handed.

The commands are plain functions taking a repo path (`lib.rs:154` onward), so
integration tests need no Tauri runtime: a temp dir, `git init`, call the
function, read the disk. A dozen of these — stamp conflict, rename onto an
existing file, folder census over ignored files — makes the fake's behaviour
*checkable against* the real one rather than parallel to it. Property-style
round-trips (write → stat → read gives back the same stamp and bytes) are the
Rust twin of what `roundtrip.spec.ts` already does for the formatter.

## Gap 3: bugs that live in *time* have no harness

The two open bugs that aren't already planned elsewhere are both about change
noticed too late: only the active file is stat-polled, so background tabs go
stale (`BUGS.md:15`, pointing at `App.tsx:1028`), and a file was corrupted in
a way "nothing surfaced" (`BUGS.md:17`). The suite tests the conflict dialog
when the *active* file changes underneath an edit (`app.spec.ts:135`) and
that a vanished file is not a conflict (`app.spec.ts:415`) — but no test
mutates a file behind a *background* tab and asserts anything. The fake makes
this easy — `window.__fake` is exposed exactly so tests can reach in
(`fake-backend.ts:254`) — the test just hasn't been written, and writing it
first would pin the fix for the stamp-poll bug before it is built.

The frontmatter corruption wants a different kind of test: an invariant, not a
scenario. After any editor round-trip the fake can assert the written content
has at most one leading fence pair. A check like that belongs in the fake's
`write_plan` handler itself, where it guards *every* test that types, rather
than in one spec that has to guess the reproduction.

## What this plan is not

Not tauri-driver, not a packaged-app harness, not visual regression beyond the
existing `shots.spec.ts`. The config's argument still holds
(`playwright.config.ts:5-11`); the three harness-vs-app failures in
`BUGS.md:37-40` were all *WebView platform* differences, and no amount of
faking fixes those — they are caught by using the app, which the daily
dogfooding this repo runs on already does. The budget goes to the seams that
tests *can* hold.

## Open questions

- Where does the parity check run — a cargo test that parses its own source,
  or a node script in CI that parses both sides? The cargo test is
  self-locating but grep-parses Rust; the script is honest about being a grep.
- Should the fallback *throw* under test for unknown commands instead of
  recording? Stricter, but it re-derails tests on incidentals, which the
  comment at `fake-backend.ts:240` deliberately chose against.
- Do the Rust integration tests shell out to real `git init`, or is a bare
  `.git` fixture enough? Real git matches production; it also makes `cargo
  test` depend on the environment in a way it currently doesn't.
- Is the frontmatter invariant right for *all* files? A document that
  legitimately starts with `---` as a thematic break would trip a naive
  check — the assertion needs to say what it means by "fence".

## Done when

- Adding a Rust command without faking or allowlisting it fails a check, not
  silently succeeds through the fallback.
- The real `write_plan` / `rename_plan` / `create_plan` have integration tests
  on a real temp directory, so the fake has something to be measured against.
- A test edits a file behind a background tab and asserts the app notices —
  red today, green when the stamp poll widens.
- No test that types can write a double-fence file without the harness itself
  objecting.

## Next

- [ ] Parity check: `generate_handler!` list (`lib.rs:1027`) vs fake handler
      keys plus a fallback allowlist
- [ ] Record fallback hits in `state.calls`; assert none unexpected in one
      ordinary-session spec
- [ ] Rust integration tests over a temp repo for the write-path commands
      (`write_plan`, `rename_plan`, `create_plan`, `delete_folder`)
- [ ] Frontmatter invariant in the fake's `write_plan` handler
- [ ] Background-tab staleness spec, written before the stamp-poll fix
      (`BUGS.md:15`) so it pins the behaviour
