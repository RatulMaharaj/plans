---
"looped-plans": minor
---

Looped Plans builds for Linux. The release carries an x86_64 AppImage and a
`.deb` beside the macOS and Windows bundles, from the same tag and with the
same update feed, so an installed AppImage updates itself the way a Mac copy
does. It was aimed at Arch under Hyprland: on Wayland with the NVIDIA driver
the app turns WebKitGTK's DMA-BUF renderer off before the window opens
(`PLANS_WEBKIT_SAFE=1` forces it), the workspace sign-in falls back to a
0600 file when there is no keyring daemon to hold it, "Open in terminal"
honours `$TERMINAL` and knows ghostty, alacritty, kitty, foot and wezterm,
the `plans` command installs to `~/.local/bin`, and the monospace stacks
carry JetBrains Mono and DejaVu Sans Mono. An AUR `PKGBUILD` template lives
under `packaging/aur/`. Flatpak, Snap and ARM are not in this release.
