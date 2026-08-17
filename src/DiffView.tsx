import { useEffect, useMemo, useRef, useState } from "react";
import { createPatch } from "diff";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { api } from "./api";
import type { Settings } from "./settings";

type Props = {
  repo: string;
  relPath: string;
  /** The live editor buffer, so the diff can move as you type. */
  buffer: string;
  settings: Settings;
  /** Bumped after any git action so the committed side is re-read. */
  epoch: number;
};

/**
 * Live redline against the committed file.
 *
 * The committed side comes from `git show HEAD:<path>`. The working side is
 * whatever is in the editor right now — not what's on disk — so changes show up
 * as they're typed rather than after a save. The patch is built in the browser
 * with jsdiff and handed to @pierre/diffs to render.
 */
export function DiffView({ repo, relPath, buffer, settings, epoch }: Props) {
  const [head, setHead] = useState<string | null>(null);
  const [disk, setDisk] = useState("");
  const [settled, setSettled] = useState(buffer);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setHead(null);
    Promise.all([
      api.gitHeadText(repo, relPath).catch(() => ""),
      api.readPlan(repo, relPath).catch(() => ""),
    ]).then(([h, d]) => {
      if (!live) return;
      setHead(h);
      setDisk(d);
    });
    return () => {
      live = false;
    };
  }, [repo, relPath, epoch]);

  // Re-diffing on every keystroke is wasted work; a short settle is invisible.
  useEffect(() => {
    if (!settings.diffLive) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSettled(buffer), 220);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [buffer, settings.diffLive]);

  const working = settings.diffLive ? settled : disk;

  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (head === null) return null;
    const patch = createPatch(relPath, head, working, "committed", "working", {
      context: settings.diffExpandUnchanged ? 100000 : 3,
    });
    try {
      return parsePatchFiles(patch)[0]?.files?.[0] ?? null;
    } catch {
      return null;
    }
  }, [head, working, relPath, settings.diffExpandUnchanged]);

  if (head === null) {
    return <p className="diff-state">Reading the committed version…</p>;
  }

  if (head === "") {
    return (
      <p className="diff-state">
        This plan isn't committed yet, so there's nothing to compare it against.
      </p>
    );
  }

  if (!fileDiff) {
    return <p className="diff-state">No changes since the last commit.</p>;
  }

  return (
    <div className="diff-surface">
      <FileDiff
        key={`${relPath}-${settings.diffStyle}-${settings.diffLineNumbers}-${settings.diffWrap}`}
        fileDiff={fileDiff}
        options={{
          diffStyle: settings.diffStyle,
          themeType: settings.theme === "night" ? "dark" : "light",
          overflow: settings.diffWrap ? "wrap" : "scroll",
          disableLineNumbers: !settings.diffLineNumbers,
          disableFileHeader: true,
          expandUnchanged: settings.diffExpandUnchanged,
        }}
      />
    </div>
  );
}
