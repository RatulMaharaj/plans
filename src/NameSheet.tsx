/**
 * Asking for a filename.
 *
 * WKWebView has no window.prompt — Tauri implements alert and confirm, but not
 * that one, so it silently returns null and nothing happens. This asks properly,
 * and shows the path that will be written before anything is.
 */
import { useEffect, useRef, useState } from "react";

export function slugOf(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
}

type Props = {
  /** Repo-relative folder the file will land in; "" is the repo root. */
  dir: string;
  /** Shown above the field, so it's clear which repository this is. */
  repoName: string;
  onCancel: () => void;
  onCreate: (relPath: string, title: string) => void;
};

export function NameSheet({ dir, repoName, onCancel, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const name = `${slugOf(title)}.md`;
  const relPath = dir ? `${dir}/${name}` : name;

  const submit = () => {
    if (!title.trim()) return;
    onCreate(relPath, title.trim());
  };

  return (
    <div className="matter-scrim" onMouseDown={onCancel}>
      <div className="matter-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="matter-head">
          <span className="tag">New file</span>
          <span className="tag">{repoName}</span>
        </div>
        <input
          ref={field}
          className="name-field"
          value={title}
          placeholder="Title"
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <p className="name-path">{title.trim() ? relPath : dir || "repository root"}</p>
        <div className="matter-foot">
          <span>⏎ create · esc cancel</span>
          <button className="act" onClick={submit} disabled={!title.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
