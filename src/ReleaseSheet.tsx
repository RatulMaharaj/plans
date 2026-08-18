/**
 * What changed, in the version you are running.
 *
 * The notes are bundled (`src/release-notes.ts`, generated from CHANGELOG.md by
 * scripts/sync-version.mjs), so this opens offline, opens instantly, and opens
 * for someone who installed the .dmg by hand and never touches the updater.
 *
 * The rendering is deliberately small. Changesets writes a heading and a bullet
 * list; running that through Milkdown would mean a second editor instance for a
 * page nobody edits.
 */
import { useEffect } from "react";

type Props = {
  version: string;
  /** The markdown section for that version. Empty is a legitimate answer. */
  notes: string;
  onClose: () => void;
};

/** Bullets and headings, which is all changesets ever writes. */
function render(notes: string) {
  const out: React.ReactNode[] = [];
  let bullet: string[] = [];

  const flush = () => {
    if (!bullet.length) return;
    out.push(
      <ul key={`ul-${out.length}`} className="release-list">
        {bullet.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    );
    bullet = [];
  };

  // Bullets wrap across lines in CHANGELOG.md, so a line that isn't a new
  // bullet continues the last one.
  for (const line of notes.split("\n")) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (item) {
      bullet.push(item[1]);
    } else if (head) {
      flush();
      out.push(
        <p key={`h-${out.length}`} className="release-head">
          {head[1]}
        </p>,
      );
    } else if (line.trim() && bullet.length) {
      bullet[bullet.length - 1] += ` ${line.trim()}`;
    } else if (line.trim()) {
      flush();
      out.push(
        <p key={`p-${out.length}`} className="release-para">
          {line.trim()}
        </p>,
      );
    }
  }
  flush();
  return out;
}

export function ReleaseSheet({ version, notes, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="matter-scrim" onMouseDown={onClose}>
      <div
        className="matter-sheet"
        role="dialog"
        aria-label={`What's new in ${version}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="matter-head">
          <span className="tag">What's new</span>
          <span className="release-version">{version}</span>
        </div>

        <div className="release-body">
          {notes.trim() ? (
            render(notes)
          ) : (
            <p className="none">No notes were written for this version.</p>
          )}
        </div>

        <div className="matter-foot">
          <span>esc close</span>
          <button className="act" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
