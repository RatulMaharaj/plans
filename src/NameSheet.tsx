/**
 * Asking for a filename.
 *
 * WKWebView has no window.prompt — Tauri implements alert and confirm, but not
 * that one, so it silently returns null and nothing happens. This asks properly,
 * and shows the path that will be written before anything is.
 */
import { useEffect, useRef, useState } from "react";
import type { RepoInfo } from "./api";
import { Dropdown } from "./Dropdown";

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
  /** Which repository it lands in, and the ones it could land in instead. */
  repo: string;
  repos: RepoInfo[];
  onRepoChange: (path: string) => void;
  /** Folders in the chosen repository, so the file can be placed. */
  dirs: string[];
  onDirChange: (dir: string) => void;
  onCancel: () => void;
  onCreate: (relPath: string, title: string) => void;
};

export function NameSheet({
  dir,
  repo,
  repos,
  onRepoChange,
  dirs,
  onDirChange,
  onCancel,
  onCreate,
}: Props) {
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
        </div>

        {/* Where it goes, chosen rather than assumed. */}
        <div className="name-where">
          <Dropdown
            ariaLabel="Repository"
            value={repo}
            onChange={onRepoChange}
            choices={repos.map((r) => ({ value: r.path, label: r.name, note: r.branch }))}
          />
          <span className="name-sep">/</span>
          <Dropdown
            ariaLabel="Folder"
            value={dir}
            onChange={onDirChange}
            choices={[
              { value: "", label: "repository root" },
              ...dirs.map((d) => ({ value: d, label: d })),
            ]}
          />
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
