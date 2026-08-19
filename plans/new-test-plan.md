---
status: active
---
# A test plan

I want to have e2e tests for this app — and mostly, now, I have them. What
this plan owes is the argument for their shape, and an honest account of the
seams that shape leaves open, because the shape is unusual: the frontend runs
in a real browser with the entire Rust boundary faked, and the packaged app is
never driven at all.

## Why the browser, not the app

The obvious e2e story — WebDriver against the built Tauri bundle — is closed
off: tauri-driver has no macOS support, which `playwright.config.ts:6` says
out loud. But the constraint turned out to be a design. Every failure this
project has actually shipped lived in the frontend or at the IPC boundary
(`playwright.config.ts:8`), and both are reachable by pointing Playwright at
the dev server with `invoke` stubbed. The Rust side is a separate program
with a separate test runner; CI runs `cargo test` beside the Playwright job
(`.github/workflows/ci.yml:78` and `ci.yml:44`), and the modules that hold
logic carry their own `#[cfg(test)]` blocks (`chat.rs:246`, `lib.rs:1284`).

The whole trick is one function. `installFakeBackend` replaces
`__TAURI_INTERNALS__.invoke` (`fake-backend.ts:314`) before any app code
runs, answers every command the app issues from an in-memory repository, and
records every call it sees (`fake-backend.ts:37`). That last part matters
more than the simulation: tests assert on *what the app sent* — that a chat
turn carried the plan's path (`chat.spec.ts:127-133`), that talking never
commits (`chat.spec.ts:225`) — which is exactly the contract the real backend
receives. The fake also owns the event plumbing (`fake-backend.ts:269`), so a
test can play the backend's half of a streaming conversation with
`__fake.emit` and the app cannot tell the difference.

Two boundary details were bought with real bugs and are worth keeping named:

- **The port is not the app's.** A Tauri dev window shares an origin — and a
  localStorage — with anything on its port, and the tests once emptied a
  running app's repository list. Port 1430 is a second origin
  (`playwright.config.ts:27-36`).
- **Unlisten must really unlisten.** StrictMode mounts twice; a fake that
  keeps the first listener delivers every event twice
  (`fake-backend.ts:266-268`).

## What each suite is for

The suites divide by *kind of promise*, not by component:

- `app.spec.ts` — the bugs that actually happened, one test each: the
  destructive open, the crash on switching files, the stale write
  (`app.spec.ts:2-8`). Regression tests with names.
- `chat.spec.ts` — the agent wiring, not the agent: nothing sent until someone
  speaks, sessions surviving turns, geometry of where the panel lands
  (`chat.spec.ts:241-247` argues for asserting bounding boxes over class
  names, which is right — a lost specificity fight leaves the class on).
- `agent.spec.ts` — pure functions on the process boundary, no browser:
  argv splitting, where a badly quoted path runs the wrong thing
  (`agent.spec.ts:2-7`).
- `telemetry.spec.ts` — the Settings-page promise verified at the wire, with
  sentinel prose that would be unmistakable if it escaped
  (`telemetry.spec.ts:16`).
- `perf.spec.ts` — budgets, not benchmarks: loose enough that only a
  regression trips them (`perf.spec.ts:8-13`).
- `roundtrip.spec.ts` — the formatters plan's load-bearing assumption
  (Prettier and Milkdown agree on a fixpoint), answered before shipping.
- `html.spec.ts`, `updates.spec.ts`, `shots.spec.ts` — READMEs render, the
  update banner behaves, and the screenshots are the real app (gated behind
  `SHOTS=1`, `shots.spec.ts:14`, so `pnpm test` stays about behaviour).

Two workers, not one per core: each test boots a Milkdown editor, and four at
once fail on timing rather than behaviour (`playwright.config.ts:14-20`).

## The seam the shape leaves open

The fake is a second implementation of the command surface, maintained by
hand. When `list_plans` grew a `status` field for the tree filter, the fake
had to learn to parse frontmatter too (`fake-backend.ts:88-94`) — and it was
a comment, not a compiler, that knew. A command the Rust side renames or
re-types fails silently here: the fallback answers `""` for anything unknown
(`fake-backend.ts:306`), which keeps tests from derailing on incidental
commands but also means a typo'd command name tests nothing. That fallback is
the suite's one real blind spot, and it is deliberate; the question is
whether it should stay quiet or log loudly enough to notice in a trace.

The other seam is the untested half-inch of real Tauri: window creation, the
updater's actual install-and-relaunch (verified by hand, once, against a
published release — `updates.spec.ts:4-7`), and the CLI's `plans .` entry.
These are thin, they change rarely, and driving them would cost a Linux
tauri-driver lane for coverage of code that mostly isn't ours. Not worth it
yet; worth writing down that it was decided rather than forgotten.

## Open questions

- **Should the fake's fallback shout?** A test-visible list of commands that
  hit `fallback` (`fake-backend.ts:306`) would catch renames for free. The
  risk is noise from genuinely incidental commands like push; maybe an
  allowlist is the honest middle.
- **A contract test against the real commands?** `cargo test` could assert
  each command's serialized shape against fixtures the fake also reads.
  Probably overkill while one person edits both sides in one commit — the
  `list_plans` incident argues it isn't, one more incident decides it.
- **Do the perf budgets belong in CI?** They run there now and haven't
  flaked, but the config's own reasoning about starved workers applies
  doubly to shared runners. Keep them until they lie.
- **A Linux tauri-driver lane, ever?** Only if a real-window bug actually
  ships. The trigger is the bug, not the coverage number.

## Next

- [x] Playwright against the dev server on its own origin, Rust boundary
  faked at `invoke` (`fake-backend.ts`, `playwright.config.ts`)
- [x] Regression suite from the bugs that shipped (`app.spec.ts`)
- [x] Chat wiring and panel geometry (`chat.spec.ts`)
- [x] Pure-function suite for the process boundary (`agent.spec.ts`)
- [x] Telemetry promise tested at the wire (`telemetry.spec.ts`)
- [x] Perf budgets, HTML rendering, updater, formatter roundtrip, screenshots
- [x] CI: Playwright with traces on failure, `cargo test`, fmt, clippy
  (`.github/workflows/ci.yml`)
- [ ] Decide the fallback question: make unknown commands visible in the
  fake's `calls` log, or record why quiet is correct
- [ ] Sweep the fake against `lib.rs`'s current command list once, by hand,
  and note the date — the cheap version of the contract test
