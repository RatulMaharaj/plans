---
"looped-plans": minor
---

Looped Plans builds for Windows. The release carries an x64 installer beside
the macOS one, from the same tag and with the same update feed, so a Windows
copy updates the way a Mac one does. On Windows the agents resolve through
PATHEXT the way the shell would, git and npm run without a console window
flashing, "Open in terminal" opens Windows Terminal where it is installed,
and shortcuts are spelled Ctrl+Shift+O rather than ⌘⇧O. The `plans` command
line and tmux sessions stay macOS-only for now, and the installer is not yet
code-signed, so SmartScreen asks once. Repositories under WSL (`\\wsl$\...`)
are not supported in this release.
