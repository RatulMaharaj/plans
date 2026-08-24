import { useEffect, useMemo, useRef, useState } from "react";
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { EditProvider, FileDiff } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/edit";
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
  /** Edits made on the working side of the diff, as full file text. */
  onEdit: (text: string) => void;
};

/**
 * Live redline against the committed file.
 *
 * The committed side comes from `git show HEAD:<path>`. The working side is
 * whatever is in the editor right now — not what's on disk — so changes show up
 * as they're typed rather than after a save. The patch is built in the browser
 * with jsdiff and handed to @pierre/diffs to render.
 */
/**
 * Committed text by `repo::relPath`, so a diff can paint before its fetch
 * returns. Filled by prefetch when the status lists a changed file, and by
 * every fetch the view itself makes; always revalidated in the background,
 * so a stale entry costs one repaint, never a wrong diff left standing.
 */
const headCache = new Map<string, string>();

/** Warm the cache for a changed file, so clicking it shows the diff at once. */
export async function prefetchHead(repo: string, relPath: string): Promise<void> {
  try {
    headCache.set(`${repo}::${relPath}`, await api.gitHeadText(repo, relPath));
  } catch {
    /* the view's own fetch will report the problem */
  }
}

/**
 * A content fingerprint for @pierre/diffs' `cacheKey`, which its worker uses
 * to skip re-highlighting. The contract is that a key names exact contents —
 * "if you modify the contents of the diff in any way, you will need to update
 * the cacheKey" — and a stale key left a freshly-switched diff rendering as
 * the previous file's, or as nothing at all.
 */
function fingerprint(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}.${h >>> 0}`;
}

export function DiffView({ repo, relPath, buffer, settings, epoch, onEdit }: Props) {
  // The component is keyed by file where it is mounted, so state initialises
  // per document — which is what lets a prefetched committed side paint on
  // the very first render, with no "Reading…" beat.
  const [head, setHead] = useState<string | null>(
    () => headCache.get(`${repo}::${relPath}`) ?? null,
  );
  const [disk, setDisk] = useState<string | null>(null);
  const [settled, setSettled] = useState(buffer);
  const timer = useRef<number | null>(null);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  // One editor for the surface; the provider hands it to whichever file is
  // showing. Created once so the undo stack survives re-renders.
  const createEditor = useMemo(
    () => (options: ConstructorParameters<typeof Editor>[0]) => new Editor(options),
    [],
  );

  // Revalidate on mount and after every git action (epoch). A cached head
  // stays on screen while the fresh one is read, so an epoch bump repaints
  // in place instead of blanking to "Reading…". Two independent reads: the
  // committed side gates the diff, the disk copy only matters with live diff
  // off, so neither waits for the other.
  useEffect(() => {
    let live = true;
    void api
      .gitHeadText(repo, relPath)
      .catch(() => "")
      .then((h) => {
        headCache.set(`${repo}::${relPath}`, h);
        if (live) setHead(h);
      });
    void api.readPlan(repo, relPath).then(
      (r) => live && setDisk(r.content),
      () => live && setDisk(""),
    );
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

  // Null until the disk copy arrives: diffing against "" would paint one
  // giant deletion for a beat. The live buffer needs no such wait.
  const working = settings.diffLive ? settled : disk;

  /**
   * Built from both files whole, not from a patch. A patch-parsed diff is
   * `isPartial` — it holds only the lines the patch mentions — and an edit
   * session has no document to attach to, so hunks render but can't be typed
   * in. Passing full contents gives the editor something to edit.
   */
  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (head === null || working === null) return null;
    try {
      const diff = parseDiffFromFile(
        { name: relPath, contents: head, cacheKey: `${relPath}:committed:${fingerprint(head)}` },
        { name: relPath, contents: working, cacheKey: `${relPath}:working:${fingerprint(working)}` },
      );
      return diff.hunks.length ? diff : null;
    } catch {
      return null;
    }
  }, [head, working, relPath]);

  if (head === null || working === null) {
    return <Empty line="Reading the committed version…" />;
  }

  if (head === "") {
    return (
      <Empty
        line="Nothing to compare against yet."
        hint="This file has never been committed, so every line of it is new. Stage and commit it once and the diff starts here."
      />
    );
  }

  if (!fileDiff) {
    return (
      <Empty
        line="No changes since the last commit."
        hint={
          settings.diffLive
            ? "This compares what's in the editor, so edits show up here as you type."
            : "This compares what's saved on disk. Turn on live diff to see edits as you type."
        }
      />
    );
  }

  return (
    <div className="diff-surface">
      <EditProvider createEditor={createEditor}>
      <FileDiff
        edit
        editorOptions={{
          // The working side is the editor buffer, so edits here are edits
          // there — same pending write, same autosave, same undo semantics as
          // typing in the page.
          onChange: (file) => onEditRef.current(file.contents),
        }}
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
      </EditProvider>
    </div>
  );
}

/** The diff has three ways of being empty; they should all look deliberate. */
function Empty({ line, hint }: { line: string; hint?: string }) {
  return (
    <div className="diff-empty">
      <p className="diff-empty-line">{line}</p>
      {hint && <p className="diff-empty-hint">{hint}</p>}
    </div>
  );
}
