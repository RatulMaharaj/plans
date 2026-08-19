---
status: done
---
# tmux Sessions In The App

Plans watches files change underneath it and shows the result. What it cannot
do is show you *what is producing them* — the agent run, the dev server, the
test watcher — so the moment anything is happening you leave the app to look at
it in a terminal.

The first version of this plan built a window instead of a terminal:
`capture-pane` polled into a `<pre>` (`MuxPanel.tsx:173`), `send-keys` behind
an input box (`mux.rs:186`). It works, and it looks like what it is — a
screenshot of a terminal with a chat box under it. Verdict from using it: not
good enough. A TUI redrawing four seconds late in stripped monochrome reads as
broken, and typing into a separate input while the output sits above it never
stops feeling like SMS-ing a computer.

**The revised goal: a real terminal in the panel, with tmux still owning every
process.** The pivot replaces the *display and input* half; the discovery and
start half survives untouched.

## Why xterm.js, and why not libghostty

libghostty was considered and rejected for an architectural reason, not a
quality one. This app's entire UI is a webview; every panel is DOM inside the
grid in `App.css`. libghostty draws into a native Metal surface, so embedding
it means floating an `NSView` over the webview and keeping it pixel-aligned
with a CSS grid cell — and native views always win the z-fight, so the
terminal could never sit under the palette, a sheet, or a dropdown. Its
embedding API is also not yet a stable public target. If the Ghostty *feel* is
wanted, the honest form of that is the escape hatch below: one click that opens
the pane in actual Ghostty.

xterm.js is DOM. It lives inside `MuxPanel`'s grid cell, themes from the same
`--mono`/`--code-size` tokens the `<pre>` uses today, stacks like every other
element, and ships a fit addon that solves the measure-a-character sizing dance
`fit()` currently hand-rolls (`MuxPanel.tsx:50-67`). It becomes the app's
first real terminal dependency (`@xterm/xterm` + `@xterm/addon-fit`) — and the
first frontend dependency this feature has needed at all.

## The shape: a PTY that runs `tmux attach`

The trick that keeps this small: the PTY does not run the user's processes. It
runs one command, `tmux attach`, and tmux keeps doing everything it already
does — owning sessions, keeping processes alive across app restarts, serving
the same panes to the user's own terminal. The app's terminal is just another
tmux client. Kill the app and nothing dies; that property is the reason this
plan was tmux-shaped from the start, and it survives the pivot.

Rust side, in `mux.rs` next to what exists:

- **`portable-pty`** — the first new crate this feature needs (`Cargo.toml`
  has stayed at `opener`/`dialog`/`ignore` until now). Openpty, spawn
  `tmux ... attach`, hold the pair keyed by a session id.
- **Output streams as events.** A reader thread forwards PTY bytes to the
  frontend. Nothing in `lib.rs` emits events today — every command is
  request/response — so this is the app's first push channel, and it should be
  one event name carrying `(term_id, bytes)` rather than an event per
  terminal.
- **Three commands**: `term_open(repo, target) -> TermId`,
  `term_write(id, bytes)`, `term_resize(id, cols, rows)` — resize now goes to
  the PTY, where tmux reads it from a real client, instead of the
  `resize-window` guesswork and its status-line off-by-one (`mux.rs:220-246`).
- **`term_close(id)`** kills the client, not the session. Closing the panel
  detaches; the run carries on.

### Attaching without yanking anyone's terminal

`tmux attach -t plans` joins the user's own client to the app's: selecting a
window in the app would flip the window in their terminal too. The fix is a
**grouped session**: `tmux new-session -t <session> -s plans-view-<n>` shares
the windows but keeps an independent current-window, so the app can look at
the agent pane while the user's terminal stays where it was. Set
`destroy-unattached` on the view session (scoped to it, not globally) so
closing the panel cleans it up.

Sizing note: with two clients on one session group, the server's `window-size`
option decides who wins. `latest` (the modern default) means whichever client
acted last sizes the window — acceptable, and strictly better than today,
where the app's `resize-window` fights any attached client and silently loses
(`mux.rs:241-245`).

## What survives, what dies

Survives, unchanged:

- `mux_available` gating — no tmux, no feature (`mux.rs:53`)
- `mux_panes` discovery by `pane_current_path`, component-wise (`mux.rs:65`,
  the test at `mux.rs:283` is the reason)
- `mux_start` — detached `new-window -P -F '#{pane_id}'` (`mux.rs:132`), which
  is what [`agents-flesh-out-plans.md`](./agents-flesh-out-plans.md) calls
  through `api.muxStart` (`api.ts:229`)
- `mux_send` — the *headless* answer path stays useful for agent flows that
  reply without the panel open (`agent.ts` templates hand argv to tmux the
  same way)
- The panel's placement as a bottom row, the `showGit`-shaped toggle wiring,
  and the poll-nothing-while-closed rule

Dies, and good riddance:

- The `capture-pane` poll and its interval plumbing (`MuxPanel.tsx:94-114`)
- `stripAnsi` (`pane.ts`) — xterm.js *wants* the ANSI
- The input box and the `mux_key` allowlist (`mux.rs:202-211`) — a real
  terminal has a keyboard, and the "door to becoming a terminal by increments"
  argument dissolves once it simply is one
- `mux_resize` and the character-measuring `fit()` — the fit addon plus PTY
  resize replace both

The old commands should actually be deleted, not stranded: `api.ts:221-239`
shrinks, and the fake backend's `mux_read`/`mux_send`/`mux_key` handlers
(`fake-backend.ts:209-226`) go with them.

## The escape hatch

The panel currently *shows* the attach command as text to copy
(`MuxPanel.tsx:166-168`). It becomes a button: open the pane in the user's
real terminal — Ghostty, iTerm, Terminal — via the `opener` crate that is
already a dependency. That covers "or opening a new one": when the embedded
terminal is not enough (a long session, a full-screen TUI), one click puts the
same tmux window in a first-class terminal, because it was tmux's window all
along.

## Testing takes a hit, and the plan should say so

`mux.spec.ts` (206 lines) drives the `<pre>` and the input box against fake
`mux_read`/`mux_send` handlers. xterm.js renders into canvas by default, so
those assertions do not port directly. The honest replacements:

- The fake backend answers `term_open` and records `term_write` — asserting
  *what the app sends* stays cheap even when reading pixels is not.
- xterm exposes its buffer programmatically (`term.buffer.active`); a test
  helper reading lines from it restores "the screen shows X" assertions
  without screenshots.
- The live cargo tests (`mux.rs:336-414`) keep covering the tmux truth: those
  are the ones that caught `-P -F` and `-l`, and they are untouched by the
  frontend pivot.

## Open questions

- One PTY per app, or one per viewed pane? A single grouped-session client
  that `select-window`s when the selector changes is cheapest; per-pane
  clients avoid flicker when switching. Start with one.
- Does the embedded terminal get app hotkeys or terminal keys? ⌘K in the
  terminal probably wants to reach tmux/the shell, but the palette must stay
  reachable — likely: terminal owns everything except a single well-known
  escape (the `esc-unfocuses-the-editor.md` question, again, for a new
  surface).
- Scrollback: tmux's (copy-mode via the client) or xterm's buffer? Letting
  tmux own it is consistent; xterm's is more natural to a mouse. Probably
  xterm's, sized modestly.
- Does `mux_send` really stay, or do agent answer flows go through
  `term_write` once a terminal exists? Keeping it means two write paths;
  dropping it couples headless agent replies to an open PTY.
- Theme: xterm takes explicit colors, not CSS variables — the panel needs a
  small map from the app's tokens to an xterm theme object, and it must track
  light/dark switching live.

## Done when

- The panel shows a real, colored, cursor-blinking terminal attached to the
  selected pane, and typing in it is just typing.
- Selecting a different pane in the app never changes the window in the
  user's own attached terminal.
- Closing the panel detaches the client; the process keeps running; nothing
  polls.
- The "open in terminal" button lands the same tmux window in the user's real
  terminal app.
- No tmux on the machine still means the feature is absent, not broken.

## Next

- [x] `exec(bin, args)` factored out of `git()` (`lib.rs:32`)
- [x] Discovery: `mux_available`, `mux_panes` by `pane_current_path` (`mux.rs`)
- [x] `mux_start` for agent runs — stays as-is (`mux.rs:138`)
- [x] `portable-pty` in `Cargo.toml`; `term_open`/`term_select`/`term_write`/
      `term_resize`/`term_close` in `mux.rs`, output on one `term-output`
      event channel carrying raw bytes
- [x] Grouped view session (`new-session -t`) with `destroy-unattached`, so
      the app never steals the user's current window — proven by the live test
      `a_grouped_view_session_has_its_own_current_window` (`mux.rs`)
- [x] xterm.js + fit addon in `MuxPanel`, replacing the `<pre>`, the input
      box, the key buttons, and the capture poll
- [x] Theme map from app tokens to xterm's theme object, following
      `data-theme` live
- [x] Attach command became an "Open in Terminal" button (`mux_open_terminal`,
      `osascript` on macOS)
- [x] `mux_read`/`mux_key`/`mux_resize` deleted end to end; `mux_send` kept
      as the headless answer path
- [x] `mux.spec.ts` reworked onto `term_*` fakes and a `__fake.emit` event
      channel; `stripAnsi` and its tests removed
- [ ] Remember the selected pane per repo across restarts (carried over)
