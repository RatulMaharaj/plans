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
export function DiffView({ repo, relPath, buffer, settings, epoch, onEdit }: Props) {
  const [head, setHead] = useState<string | null>(null);
  const [disk, setDisk] = useState("");
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

  useEffect(() => {
    let live = true;
    setHead(null);
    Promise.all([
      api.gitHeadText(repo, relPath).catch(() => ""),
      api.readPlan(repo, relPath).then((r) => r.content, () => ""),
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

  /**
   * Built from both files whole, not from a patch. A patch-parsed diff is
   * `isPartial` — it holds only the lines the patch mentions — and an edit
   * session has no document to attach to, so hunks render but can't be typed
   * in. Passing full contents gives the editor something to edit.
   */
  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (head === null) return null;
    try {
      const diff = parseDiffFromFile(
        { name: relPath, contents: head, cacheKey: `${relPath}:committed` },
        { name: relPath, contents: working, cacheKey: `${relPath}:working` },
      );
      return diff.hunks.length ? diff : null;
    } catch {
      return null;
    }
  }, [head, working, relPath]);

  if (head === null) {
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
