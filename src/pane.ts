import type { Pane } from "./api";

/** A pane running something other than a shell is doing work. */
const SHELLS = ["zsh", "bash", "fish", "sh", "tmux"];
export function isBusyPane(p: Pane | undefined): boolean {
  return !!p && !p.dead && !SHELLS.includes(p.command);
}
