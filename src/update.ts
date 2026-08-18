/**
 * Learning that a new version exists, and becoming it.
 *
 * The feed is GitHub Releases — `releases/latest/download/latest.json`, which
 * resolves to the newest *published* release, so the draft-release gate in
 * RELEASES.md is the update gate too. Nothing reaches an installed copy until
 * someone has opened the draft, checked the installer, and pressed Publish.
 *
 * Every call goes through `timed` so update work lands in the perf HUD next to
 * the IPC it is made of.
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { timed } from "./perf";

export type Available = {
  version: string;
  /** The `notes` field of latest.json — CHANGELOG's section for that version. */
  notes: string;
  /** Held so the download can start without asking GitHub a second time. */
  update: Update;
};

/**
 * Ask the feed. Resolves to null when there is nothing newer, and *throws*
 * when the question could not be asked — offline, a proxy, GitHub having a bad
 * afternoon. The two are different: a check the reader asked for should report
 * the failure, and an automatic one should swallow it.
 */
export async function checkForUpdate(): Promise<Available | null> {
  const update = await timed("update check", () => check());
  if (!update) return null;
  return { version: update.version, notes: update.body?.trim() ?? "", update };
}

/**
 * Download and install, reporting bytes as they arrive, then relaunch into the
 * new version. Nothing here happens without a press.
 */
export async function installUpdate(
  found: Available,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  let total = 0;
  let got = 0;

  await timed("update download", () =>
    found.update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        got = 0;
        // A server that sends no content-length gives us no fraction to show;
        // the banner falls back to an indeterminate bar rather than lying.
        onProgress(total ? 0 : null);
      } else if (event.event === "Progress") {
        got += event.data.chunkLength;
        onProgress(total ? Math.min(1, got / total) : null);
      } else if (event.event === "Finished") {
        onProgress(1);
      }
    }),
  );

  await relaunch();
}

/** The version actually running, which is the only one worth comparing. */
export function runningVersion(): Promise<string> {
  return timed("app version", () => getVersion());
}

/**
 * Semver-ish compare, enough for "is `a` newer than `b`". Prereleases sort
 * before their release, which is the conventional reading and the only one that
 * matters here.
 */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => {
    const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // 1.0.0 is newer than 1.0.0-rc.1
  if (!y.pre) return false;
  return x.pre > y.pre;
}
