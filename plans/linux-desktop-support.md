---
status: ready
---
# Linux desktop support, Arch and Omarchy first

> I also want to add support for Arch/Omarchy linux please

## Problem

The Windows plan made the binary honest and the release carry it. Linux is
the third host, and the one this project's own tooling is closest to: the
Rust already has `target_os = "linux"` branches for opening files and
terminals (`src-tauri/src/lib.rs`), the keychain crate is built with the
Secret Service backend, and agent discovery is Unix-shaped, so most of the
app works there today. What does not exist is a build anyone can install, a
way for it to update itself, and the handful of places where "Linux" has
been "Ubuntu with GNOME" by default. Omarchy — Arch, Hyprland, Wayland,
Alacritty or Ghostty, no GNOME — is the honest target: a build that works
there works on the friendlier distributions too.

## Approach

- **AppImage is the artifact, because it is the only one the updater can
  replace in place.** Tauri's updater on Linux handles AppImage and nothing
  else, and the whole updater story (`plans/4_auto-updates.md`) rests on an
  installed copy finding its next version in `latest.json`. So the release
  builds an AppImage for `x86_64-unknown-linux-gnu`, signs it with the
  existing updater key, and the feed gains a `linux-x86_64` entry. A `.deb`
  is bundled too, for the people who want one, without an updater promise.
- **An AUR package is how Arch installs things**, and it is a follow-up:
  `looped-plans-bin`, a `PKGBUILD` that fetches the release's AppImage and
  installs a desktop entry. It can be generated from the release, but it
  needs an AUR account and a maintainer, which is a decision rather than a
  build step. This plan leaves a `packaging/aur/PKGBUILD` template in the
  repository and the release notes point at it.
- **WebKitGTK on Wayland is where a Tauri app actually breaks.** Under
  Hyprland with an NVIDIA card the webview renders black or flickers unless
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set; on some compositors
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` is the one. The app sets the first at
  startup on Linux when it detects Wayland and an NVIDIA driver (or when
  `PLANS_WEBKIT_SAFE=1` is set), and RELEASES.md says which variables a
  reader can try. Nothing of this is guesswork worth hiding: it is the
  known state of WebKitGTK.
- **The keychain may not exist.** `keyring` speaks Secret Service over
  D-Bus; Omarchy does not ship gnome-keyring or KWallet by default, so
  `workspace_token_get` fails rather than answering "nothing". The commands
  fall back to a file under `$XDG_CONFIG_HOME/plans/token` with mode 0600
  when no Secret Service answers, and say so once in the log. Sign-in must
  not depend on a daemon the distribution does not install.
- **Terminals and openers.** `open_in_terminal` tries
  `x-terminal-emulator` then `gnome-terminal`; Omarchy has neither. The
  list grows: `$TERMINAL` if set, then `ghostty`, `alacritty`, `kitty`,
  `foot`, `wezterm`, then the two it has. Each takes a working directory
  differently, so this is a small table, not a loop. `xdg-open` for files
  and folders already works.
- **The `plans` CLI.** `install_cli` is Homebrew-shaped. On Linux it writes
  the same shell script to `$HOME/.local/bin/plans` (creating the folder)
  and `cli_status` reports whether that is on `PATH`, since on most shells
  it already is.
- **The keyboard** already spells `mod` as Ctrl off the Mac; the Windows
  plan's `platform.ts` grows `IS_LINUX`, and the spare modifier is Alt as on
  Windows.
- **Fonts**: the reading faces are vendored; the monospace stack gains
  `JetBrains Mono` and `DejaVu Sans Mono` before the generic tail, since
  those are what Arch users have.

## Implementation guide

- [ ] `src-tauri/src/lib.rs` - the WebKitGTK environment set at startup on
      Linux under Wayland + NVIDIA, or `PLANS_WEBKIT_SAFE=1`; the terminal
      table; `install_cli`/`cli_status` for `~/.local/bin`
- [ ] `src-tauri/src/lib.rs` - the keychain commands fall back to a 0600
      file under the config directory when Secret Service is unavailable
- [ ] `src/platform.ts`, `src/keys.ts`, `src/fonts.ts` - `IS_LINUX`, Alt as
      the spare modifier, the monospace stack
- [ ] `.github/workflows/release.yml` - `build-linux` on `ubuntu-22.04`
      with the WebKitGTK/AppIndicator dev packages Tauri needs, `--bundles
      appimage,deb`, updater signing with the existing key, artifacts beside
      the others; `verify-linux` checks the `.AppImage`, its `.sig`, the
      `.deb`, and that `latest.json` gained `linux-x86_64`
- [ ] `packaging/aur/PKGBUILD` - a `-bin` template pointed at the release
      AppImage, with a desktop entry and icon
- [ ] `RELEASES.md` - a Linux section: the AppImage, the WebKitGTK
      variables, the AUR template, the smoke checklist
- [ ] `site/index.html` - the download button offers Linux by platform,
      and the event reports it
- [ ] `src-tauri/tauri.conf.json` - a `linux` bundle section if the
      AppImage needs one (icon, category)

## Out of scope

Flatpak and Snap, which have their own updater stories; ARM Linux; a
maintained AUR package (the template is here, the account is a decision);
Wayland-native window decorations, which WebKitGTK draws itself.

## Open questions

- Should the AppImage bundle its own WebKitGTK? Tauri's does not, and an
  Arch system's WebKitGTK is newer than Ubuntu 22.04's, which is fine; the
  other way round is the risk, and building on 22.04 is the usual answer.
- The keychain fallback file: is a 0600 file in the config directory
  acceptable on a shared machine, or should the app refuse to sign in
  without a Secret Service and say why? Leaning: the file, said plainly.
