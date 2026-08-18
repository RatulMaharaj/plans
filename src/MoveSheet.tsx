/**
 * Move a file to another folder.
 *
 * Separate from renaming on purpose: they are different questions. Renaming
 * asks what a thing is called, and answering it should not mean retyping the
 * path it lives at; moving asks where it goes, and answering that is a choice
 * from what exists rather than free text with a chance of a typo.
 */
import { useEffect, useState } from "react";
import { Dropdown } from "./Dropdown";

type Props = {
  /** The file being moved, repo-relative. */
  relPath: string;
  /** Every folder in the repository, plus the root. */
  folders: string[];
  onCancel: () => void;
  onMove: (dir: string) => void;
};

export function MoveSheet({ relPath, folders, onCancel, onMove }: Props) {
  const name = relPath.split("/").pop() ?? relPath;
  const from = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const [dir, setDir] = useState(from);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (dir !== from) onMove(dir);
      }
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [dir, from, onCancel, onMove]);

  return (
    <div className="matter-scrim" onMouseDown={onCancel}>
      <div className="matter-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="matter-head">
          <span className="tag">Move</span>
          <span className="tag">{name}</span>
        </div>

        <div className="name-where">
          <Dropdown
            ariaLabel="Folder"
            value={dir}
            onChange={setDir}
            choices={[
              { value: "", label: "repository root" },
              ...folders.map((f) => ({ value: f, label: f })),
            ]}
          />
        </div>
        <p className="name-path">{dir ? `${dir}/${name}` : name}</p>

        <div className="matter-foot">
          <span>⏎ move · esc cancel</span>
          <button className="act" onClick={() => onMove(dir)} disabled={dir === from}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
}
