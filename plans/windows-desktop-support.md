---
status: done
---
# Windows desktop support

> Everything that builds on a Mac is built and checked here: the Rust
> compiles for both hosts, the workflow parses, the specs pass. What no CI
> covers is the binary itself running on Windows, so one pass on a real
> machine is still owed before the first Windows release is published; the
> checklist for it is in `RELEASES.md`, under *Windows*. Also of note: the
> Rust could only be cross-checked in part from macOS, because `ring` (pulled
> in by the updater plugin) needs Windows C headers to build. The Windows-only
> blocks were type-checked for `x86_64-pc-windows-msvc` on their own.

The tempting version of this plan is one line: add a Windows job to the
release workflow. Tauri builds for Windows, and the codebase has clearly been
written by someone glancing at Windows the whole time — `home_dir()` already
answers `USERPROFILE` when `HOME` is unset (`src-tauri/src/lib.rs:899`),
`templates_open`, `settings_open` and `open_in_terminal` all carry a
`#[cfg(target_os = "windows")]` branch (`lib.rs:986`, `lib.rs:1107`,
`lib.rs:1179`), the rename logic was written for case-insensitive filesystems
generally rather than for APFS specifically (`lib.rs:731`, `lib.rs:744`), and
the keychain crate was compiled with `windows-native` from day one
(`src-tauri/Cargo.toml:37`), so the workspace token already knows where to
live.

But a build that compiles is not the app. The center of this app is talking
to agents, and agent discovery does not work on Windows at all — not
degraded, structurally broken. That, not CI, is the real work; the workflow
is the second half. So the plan is in two parts: make the binary honest, then
make the release carry it.

## Part one: the binary

### Agent discovery is Unix-shaped

`discover::resolve` splits PATH on `':'` (`src-tauri/src/agent/discover.rs:52`)
— on Windows the separator is `';'`, so the split produces garbage directories
and nothing ever resolves. It then joins the bare name and asks `is_file`
(`discover.rs:53-54`), but on Windows `npx` is `npx.cmd` and `claude-agent-acp`
is `claude-agent-acp.cmd`; the extensionless file does not exist. And
`login_path` runs `$SHELL -lc` with a `/bin/sh` fallback (`discover.rs:29-31`)
— `SHELL` is unset on Windows and `/bin/sh` is not there, so it returns `None`
every time.

The fixes are individually small and worth doing as portable code rather than
a `#[cfg]` forest. `std::env::split_paths` replaces the `':'` split and is
correct on both platforms. Resolution should try the candidate name plus the
`PATHEXT` extensions (`.cmd`, `.exe`, `.bat` cover everything npm and
installers actually produce). `login_path` can simply return `None` on
Windows without loss: the whole reason it exists is that macOS GUI apps
inherit launchd's stripped PATH (`discover.rs:13-19`), and Windows has no
equivalent problem — a GUI process gets the same user PATH the terminal gets,
which is exactly the fallback `resolve` already takes
(`discover.rs:50-51`).

One wrinkle: a `.cmd` script cannot be `Command::new`'d directly the way an
ELF or Mach-O binary can — Windows wants it run through `cmd /C` or via the
`.exe` shim npm also installs. The ACP session spawns `argv[0]` as an absolute
program (`src-tauri/src/agent/session.rs:38-40`), so resolution should
prefer the `.exe` shim where npm provides one and fall back to wrapping
`.cmd`. This is the part to test on a real machine, not reason about.

### Every subprocess will flash a console

`exec` is a bare `Command::new(bin)` (`lib.rs:3`, `lib.rs:36`), and every git
call, tmux probe and opener goes through it — the design is explicitly "one
short-lived subprocess in the shape of `git()`" (`src-tauri/src/mux.rs:6-8`).
On Windows, a GUI-subsystem app spawning a console-subsystem child (git.exe,
cmd.exe) pops a console window for each one. The app polls git every few
seconds; that is a strobe light. `exec` needs
`creation_flags(CREATE_NO_WINDOW)` behind `#[cfg(windows)]`, once, at the
single choke point — which is the reward for having routed everything through
one function. The same flag belongs on the `npm install -g` call in
`agent_install` (`discover.rs:310`) and on the agent spawn if the SDK exposes
it.

Relatedly, `open_in_terminal`'s Windows branch interpolates the path into
`cd /d {path}` unquoted (`lib.rs:1183`) — a repository under
`C:\Users\First Last\` breaks it. Quote it, and consider Windows Terminal
(`wt -d {path}`) with the `cmd /K` form as the fallback, mirroring how the
Linux branch already tries two emulators (`lib.rs:1175-1177`).

### What degrades honestly, and what to hide

- **tmux sessions**: `mux_available` shells out to `tmux -V` and the UI hides
  the whole feature on `None` (`mux.rs:51-57`). tmux does not exist on
  Windows outside WSL; the existing design already degrades correctly, and
  nothing more is owed in v1.
- **The `plans` CLI**: `install_cli` writes a `#!/bin/sh` script into
  Homebrew's bin directories (`lib.rs:1225`, `lib.rs:1254-1258`) — every line
  of it is macOS. The Windows shape is a `plans.cmd` shim in a per-user
  directory that is added to the user PATH via the registry, which is a
  different mechanism with different failure modes. Rather than fake it,
  `cli_status`/`install_cli` should report "not available on Windows yet" and
  Settings should hide the control, the same honesty `mux_available` shows.
  A follow-up plan can argue the real install.
- **The dev-build dock icon** is already fenced to
  `all(debug_assertions, target_os = "macos")` (`lib.rs:1642`) and costs
  nothing.

### The window and the keyboard

`titleBarStyle: "Overlay"` and `hiddenTitle` (`src-tauri/tauri.conf.json:16-17`)
are macOS-only knobs; Windows ignores them and draws a native title bar. That
is the right v1: the rail's left padding exists to clear the traffic lights
(`src/App.tsx:5423`), and on Windows it just becomes breathing room. A custom
overlay title bar with drag regions is real work for polish, not for support.

The keyboard already speaks both dialects: `mod` is ⌘ or, elsewhere, Ctrl
(`src/keys.ts:178-184`), so the whole ⌘K family arrives as Ctrl+K for free.
The one binding to audit is the meta+ctrl chord at `src/App.tsx:4902`, which
has no Windows spelling and needs either a remap or a preset entry.

Fonts: only Space Mono is vendored — "the rest are faces macOS already has"
(`src/fonts.ts:21`). Windows has none of them, so the reading face falls to
whatever the stack's generic tail says. Verify the fallback reads acceptably
(Segoe UI is fine; a serifless fallback for a serif face is not) and vendor
or substitute where it doesn't.

## Part two: the release

`release.yml` is one macOS job plus a macOS-shaped verify: `runs-on:
macos-14` (`.github/workflows/release.yml:42`), a universal-darwin target
argument (`release.yml:164`), artifact paths under
`universal-apple-darwin/release/bundle` (`release.yml:186-188`), and a verify
job that mounts the `.dmg` with `hdiutil` and asks `codesign` and `spctl`
(`release.yml:251-275`). Windows becomes a second `build` job on
`windows-latest` — not a matrix over the existing one, because almost nothing
is shared: the signing steps, the linker workaround (`release.yml:117-127`)
and the artifact paths are all Apple-specific, and a matrix would be a page
of `if:` conditions pretending two different jobs are one.

Both jobs run the same `tauri-action` step against the same tag, and this is
the load-bearing fact: when the second platform's job uploads, `tauri-action`
merges its entries into the `latest.json` already attached to the draft
release, so one feed serves both platforms and the existing endpoint
(`tauri.conf.json:39-42`) never changes. The updater signature is minisign,
not Authenticode — the same `TAURI_SIGNING_PRIVATE_KEY` pair
(`release.yml:161-162`) signs the Windows artifacts, and no new updater
secret exists to lose. Installed macOS copies are unaffected by Windows
entries appearing in the feed; installed Windows copies get auto-update from
the first release that carries them, through the same publish gate the
updater plan argued (`plans/4_auto-updates.md`) — nothing reaches anyone
until the draft is published.

Bundle target: NSIS (`.exe`), not MSI. The NSIS installer bundles the
WebView2 runtime bootstrapper by default, updates in place without the MSI's
same-version-upgrade awkwardness, and is what the Tauri updater handles best.
`bundle.targets` is already `"all"` (`tauri.conf.json:47`), so on a Windows
runner this falls out without config — but pinning `"nsis"` for that job is
more honest than shipping whatever `"all"` happens to mean this quarter.

### Signing, or the absence of it

There is no Windows equivalent of the existing Apple setup, and this is the
one genuinely new decision. An unsigned installer trips SmartScreen: "Windows
protected your PC", with the real button behind "More info". The options are
an OV/EV certificate (yearly cost, and OV still shows SmartScreen until
reputation accrues), Azure Trusted Signing (cheaper, but an Azure tenancy to
maintain), or shipping unsigned and saying so on the download page.

Ship unsigned first. The macOS workflow already embodies this philosophy —
"signing degrades gracefully: without credentials the build still runs"
(`release.yml:72-74`) — and the audience for a v1 Windows build is people who
asked for it, not the public. The decision is reversible per-release; the
Apple decision (identifier, updater key) was not, which is why that one got
the ceremony. What must not happen is a `verify` job that pretends: the
Windows verify checks what is actually promised — the `.exe` exists, its
updater `.sig` exists, and `latest.json` gained a `windows-x86_64` entry —
and nothing about Authenticode until there is Authenticode to check. The
existing `latest.json` check (`release.yml:237-249`) runs once, on either
job's verify, not twice.

The `verify` job for macOS stays exactly as it is; a second, small
`verify-windows` job needs no runner tricks because everything it checks is
file-shaped. Both feed the same draft release, and `RELEASES.md` gains a
short Windows section rather than a rewrite.

### The site

`site/index.html:192` says "Download for macOS" and links the latest release.
Once a release carries two installers, the button should either say
"Download" plainly or sniff the platform; the analytics event hardcodes
`platform: "macos"` (`site/index.html:260-261`) and should report what was
actually offered. Small, but it is the first thing a Windows user meets.

## Open questions

- ~~x64 only, or ARM too?~~ Decided: x64 only. The runner exists and the
  audience mostly is; a second target is a second job and a second feed
  entry when someone needs it.
- ~~How does the ACP spawn behave with a `.cmd` shim?~~ Decided from the
  code rather than a machine: the SDK spawns through `std::process::Command`,
  which runs a `.bat`/`.cmd` through `cmd.exe` on its own when it sees the
  extension, so either shim works as `argv[0]`. `resolve` prefers the `.exe`
  anyway, because it spawns without a `cmd.exe` in between. The SDK already
  sets `CREATE_NO_WINDOW` on the agent process, so nothing was owed there.
  Confirming the whole path on a real machine is on the smoke checklist.
- **Long paths.** `safe_join`-based file operations may meet `MAX_PATH` on
  deep repositories; Rust's std handles `\\?\` prefixes in most but not all
  APIs, and `canonicalize` returns the prefixed form, which then travels into
  the frontend as a display string. Does a `\\?\C:\...` path ever surface
  in the UI, and does git accept it back? Left open; it is the kind of thing
  the smoke pass will show or not.
  - Answer:
- ~~Where does e2e stand?~~ Decided: a manual smoke checklist is enough for
  v1. It lives in `RELEASES.md`: install, open a repo, an agent turn, the
  terminal, an update.
- ~~WSL repositories.~~ Decided: not in v1. UNC paths through `safe_join`,
  git and the file watcher are a distinct project, and the release notes say
  so.

## Next

- [x] Portable `resolve`: `std::env::split_paths`, PATHEXT candidates,
      `login_path` → `None` on Windows (`discover.rs`)
- [x] `CREATE_NO_WINDOW` on `exec` and `agent_install` through one
      `no_console` helper (`lib.rs`); the agent spawn already had it in the
      SDK
- [x] The Windows terminal branch tries `wt -d` first and falls back to
      `cmd /K` with the repository as its working directory, so the path is
      never shell text at all (`lib.rs`)
- [x] Hide the `plans` CLI install on Windows instead of failing it
      (`lib.rs`, `SettingsPage.tsx`)
- [x] Audit the meta+ctrl binding and the font fallback stack on Windows:
      the spare modifier is Alt there, the sheet spells keys the Windows way,
      and the mono stacks carry Cascadia Mono and Consolas (`keys.ts`,
      `App.tsx`, `fonts.ts`, `platform.ts`)
- [x] `build-windows` job in `release.yml`: NSIS target, updater signing via
      the existing key, artifacts uploaded beside the macOS ones
- [x] `verify-windows`: `.exe` + `.sig` present, `latest.json` gained a
      `windows-x86_64` entry; the macOS verify is untouched
- [ ] One end-to-end pass on a real Windows machine: install, open a repo,
      run an agent turn, take an update. Needs a Windows machine; the
      checklist is in `RELEASES.md`.
- [x] `RELEASES.md` Windows section; site download button and its analytics
      event stop saying macOS
