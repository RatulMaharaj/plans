/**
 * The file tree.
 *
 * Repositories are the top level; every markdown file in each one hangs below
 * it in its real folder structure. The git mark rides on each row, so the tree
 * carries state ambiently and the git panel is only needed to *act*.
 */
import { memo, useEffect, useMemo, useState } from "react";
import type { PlanFile, RepoInfo } from "./api";

export type Mark = "clean" | "new" | "mod" | "staged";

export const GLYPH: Record<Mark, string> = {
  clean: "·",
  new: "+",
  mod: "~",
  staged: "▲",
};
export const MARK_WORD: Record<Mark, string> = {
  clean: "committed",
  new: "new",
  mod: "edited",
  staged: "staged",
};

type Dir = {
  kind: "dir";
  name: string;
  /** Repo-relative, "" for the repo root. */
  path: string;
  children: Node[];
};
type File = { kind: "file"; name: string; path: string; file: PlanFile };
type Node = Dir | File;

/** Fold a flat list of repo-relative paths into nested folders. */
function build(files: PlanFile[]): Node[] {
  const root: Dir = { kind: "dir", name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.relPath.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.find(
        (c): c is Dir => c.kind === "dir" && c.path === path,
      );
      if (!next) {
        next = { kind: "dir", name: parts[i], path, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({ kind: "file", name: parts[parts.length - 1], path: f.relPath, file: f });
  }
  // Folders before files, each alphabetical — the order a tree is read in.
  const sort = (d: Dir) => {
    d.children.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    for (const c of d.children) if (c.kind === "dir") sort(c);
  };
  sort(root);
  return root.children;
}

/**
 * Collapse runs of single-child folders into one row: "docs/plans" rather than
 * "docs" wrapping "plans". Deep repos are mostly such runs.
 */
function squash(nodes: Node[]): Node[] {
  return nodes.map((n) => {
    if (n.kind !== "dir") return n;
    let dir = n;
    let name = n.name;
    while (dir.children.length === 1 && dir.children[0].kind === "dir") {
      const only = dir.children[0] as Dir;
      name = `${name}/${only.name}`;
      dir = only;
    }
    return { ...dir, name, children: squash(dir.children) };
  });
}

/**
 * A folder shows the state of what's inside it. Precedence runs from the most
 * to the least in need of attention: an unsaved edit outranks an untracked
 * file, which outranks something already staged.
 */
const RANK: Record<Mark, number> = { mod: 3, new: 2, staged: 1, clean: 0 };

function rollUp(
  nodes: Node[],
  repoPath: string,
  marks: Map<string, Mark>,
  into: Map<string, Mark>,
): Mark {
  let worst: Mark = "clean";
  for (const n of nodes) {
    const m =
      n.kind === "dir"
        ? rollUp(n.children, repoPath, marks, into)
        : (marks.get(`${repoPath}::${n.path}`) ?? "clean");
    if (n.kind === "dir") into.set(`${repoPath}::${n.path}`, m);
    if (RANK[m] > RANK[worst]) worst = m;
  }
  return worst;
}

/**
 * The name as shown. With extensions off, the file reads as a title —
 * "auth-plan.md" becomes "auth plan".
 */
export function displayName(name: string, showExtensions: boolean) {
  if (showExtensions) return name;
  return name.replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ");
}

type Props = {
  repos: RepoInfo[];
  filesByRepo: Record<string, PlanFile[]>;
  /** "<repo>::<relPath>" -> mark. */
  marks: Map<string, Mark>;
  activeRepoPath: string | null;
  activePath: string | null;
  /** Keys are "<repo>::<dirPath>"; a missing key means collapsed. */
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onOpen: (repoPath: string, relPath: string) => void;
  onForgetRepo: (repoPath: string) => void;
  filter: string;
  showExtensions: boolean;
  /** Right-click actions. All of these act on one file, in its own repo. */
  onStage: (repoPath: string, relPath: string) => void;
  onUnstage: (repoPath: string, relPath: string) => void;
  onDiscard: (repoPath: string, relPath: string, mark: Mark) => void;
  onDelete: (repoPath: string, relPath: string) => void;
  /** dir is repo-relative, "" for the repo root. */
  onNewFile: (repoPath: string, dir: string) => void;
  onRename: (repoPath: string, relPath: string) => void;
  /** Open or close a whole subtree at once. */
  onSetOpen: (keys: string[], open: boolean) => void;
};

type MenuAt = {
  x: number;
  y: number;
  repo: string;
  /** The file for a file menu; the folder for a folder or repo menu. */
  path: string;
  mark: Mark;
  kind: "file" | "dir" | "repo";
};

/** Every folder key in a subtree, so a repo can be opened or closed in one go. */
function dirKeys(nodes: Node[], repoPath: string, out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "dir") {
      out.push(`${repoPath}::${n.path}`);
      dirKeys(n.children, repoPath, out);
    }
  }
  return out;
}

/**
 * Memoised: this renders thousands of rows in a large repository, and the poll
 * behind it fires every few seconds. Without this it re-rendered on any App
 * state change at all — a keystroke, a toast, the clock in the status bar.
 */
export const FileTree = memo(function FileTree(p: Props) {
  const [menu, setMenu] = useState<MenuAt | null>(null);

  // Any click, scroll, or escape puts the menu away.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    document.querySelector(".entries")?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
      document.querySelector(".entries")?.removeEventListener("scroll", close);
    };
  }, [menu]);

  /**
   * The filtered file lists, and the tree built from them.
   *
   * Deliberately independent of git state: marks change on every save, and
   * rebuilding, squashing and sorting thousands of nodes each time a file is
   * written is work for nothing. Counts are derived separately below.
   */
  const trees = useMemo(() => {
    const out: Record<string, { nodes: Node[]; kept: PlanFile[] }> = {};
    const q = p.filter.trim().toLowerCase();
    for (const r of p.repos) {
      const files = p.filesByRepo[r.path] ?? [];
      const kept = q ? files.filter((f) => f.relPath.toLowerCase().includes(q)) : files;
      out[r.path] = { nodes: squash(build(kept)), kept };
    }
    return out;
  }, [p.repos, p.filesByRepo, p.filter]);

  /** How much of each repo differs from its last commit. */
  const changedByRepo = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of p.repos) {
      out[r.path] = (trees[r.path]?.kept ?? []).filter(
        (f) => (p.marks.get(`${r.path}::${f.relPath}`) ?? "clean") !== "clean",
      ).length;
    }
    return out;
  }, [p.repos, trees, p.marks]);

  /** "<repo>::<dirPath>" -> the worst state anywhere beneath it. */
  const dirMarks = useMemo(() => {
    const into = new Map<string, Mark>();
    for (const r of p.repos) {
      rollUp(trees[r.path]?.nodes ?? [], r.path, p.marks, into);
    }
    return into;
  }, [trees, p.repos, p.marks]);

  // A filter is its own navigation — everything it matched should be visible.
  const filtering = p.filter.trim().length > 0;

  const row = (node: Node, repo: RepoInfo, depth: number): React.ReactNode => {
    const pad = { paddingLeft: `${10 + depth * 13}px` };

    if (node.kind === "dir") {
      const key = `${repo.path}::${node.path}`;
      const open = filtering || p.expanded.has(key);
      const mark = dirMarks.get(key) ?? "clean";
      return (
        <div key={key}>
          <button
            className={`row dir ${mark}`}
            style={pad}
            onClick={() => p.onToggle(key)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                repo: repo.path,
                path: node.path,
                mark,
                kind: "dir",
              });
            }}
            aria-expanded={open}
          >
            {/* The trailing slash is what says "folder" now that the arrow
                is gone — the same convention ls and a shell prompt use. */}
            <span className="row-name">{node.name}/</span>
          </button>
          {open && node.children.map((c) => row(c, repo, depth + 1))}
        </div>
      );
    }

    const mark = p.marks.get(`${repo.path}::${node.path}`) ?? "clean";
    const active = repo.path === p.activeRepoPath && node.path === p.activePath;
    return (
      <button
        key={`${repo.path}::${node.path}`}
        className={`row file ${mark} ${active ? "active" : ""}`}
        style={pad}
        onClick={() => p.onOpen(repo.path, node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            repo: repo.path,
            path: node.path,
            mark,
            kind: "file",
          });
        }}
        title={node.path}
      >
        <span className="row-name" title={mark === "clean" ? undefined : MARK_WORD[mark]}>
          {displayName(node.name, p.showExtensions)}
        </span>
      </button>
    );
  };

  if (!p.repos.length) {
    return <p className="none pad">Add a repository to begin.</p>;
  }

  const act = (fn: () => void) => {
    setMenu(null);
    fn();
  };

  return (
    <div className="tree">
      {menu && (
        <div
          className="ctx"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="ctx-path">
            {menu.kind === "repo"
              ? "Repository"
              : menu.path || "/"}
          </p>

          {menu.kind === "file" ? (
            <>
              <button
                className="ctx-item"
                onClick={() => act(() => p.onOpen(menu.repo, menu.path))}
              >
                Open
              </button>
              <button
                className="ctx-item"
                onClick={() =>
                  act(() =>
                    p.onNewFile(
                      menu.repo,
                      menu.path.includes("/")
                        ? menu.path.slice(0, menu.path.lastIndexOf("/"))
                        : "",
                    ),
                  )
                }
              >
                New file here
              </button>
            </>
          ) : (
            <button
              className="ctx-item"
              onClick={() => act(() => p.onNewFile(menu.repo, menu.path))}
            >
              New file here
            </button>
          )}

          {menu.kind === "file" && (
            <button
              className="ctx-item"
              onClick={() => act(() => p.onRename(menu.repo, menu.path))}
            >
              Rename or move…
            </button>
          )}

          <button
            className="ctx-item"
            onClick={() => act(() => void navigator.clipboard.writeText(menu.path))}
          >
            Copy path
          </button>

          {menu.kind === "file" && menu.mark !== "clean" && (
            <>
              <span className="ctx-rule" />
              {menu.mark === "staged" ? (
                <button
                  className="ctx-item"
                  onClick={() => act(() => p.onUnstage(menu.repo, menu.path))}
                >
                  Unstage
                </button>
              ) : (
                <button
                  className="ctx-item"
                  onClick={() => act(() => p.onStage(menu.repo, menu.path))}
                >
                  Stage
                </button>
              )}
              <button
                className="ctx-item warn"
                onClick={() => act(() => p.onDiscard(menu.repo, menu.path, menu.mark))}
              >
                {menu.mark === "new" ? "Discard — deletes the file" : "Reset to last commit"}
              </button>
            </>
          )}

          {menu.kind === "file" && (
            <>
              <span className="ctx-rule" />
              <button
                className="ctx-item warn"
                onClick={() => act(() => p.onDelete(menu.repo, menu.path))}
              >
                Delete
              </button>
            </>
          )}

          {menu.kind === "repo" && (
            <>
              <span className="ctx-rule" />
              <button
                className="ctx-item"
                onClick={() =>
                  act(() =>
                    p.onSetOpen(
                      [`${menu.repo}::`, ...dirKeys(trees[menu.repo]?.nodes ?? [], menu.repo)],
                      true,
                    ),
                  )
                }
              >
                Expand all
              </button>
              <button
                className="ctx-item"
                onClick={() =>
                  act(() =>
                    p.onSetOpen(dirKeys(trees[menu.repo]?.nodes ?? [], menu.repo), false),
                  )
                }
              >
                Collapse all
              </button>
              <span className="ctx-rule" />
              <button
                className="ctx-item warn"
                onClick={() =>
                  act(() => {
                    if (window.confirm("Forget this repository? Nothing on disk is touched.")) {
                      p.onForgetRepo(menu.repo);
                    }
                  })
                }
              >
                Forget this repository
              </button>
            </>
          )}
        </div>
      )}
      {p.repos.map((r) => {
        const key = `${r.path}::`;
        const open = filtering || p.expanded.has(key);
        const nodes = trees[r.path]?.nodes ?? [];
        const changed = changedByRepo[r.path] ?? 0;
        return (
          <div className="tree-repo" key={r.path}>
            <button
              className={`row repo ${r.path === p.activeRepoPath ? "current" : ""}`}
              onClick={() => p.onToggle(key)}
              aria-expanded={open}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  repo: r.path,
                  path: "",
                  mark: "clean",
                  kind: "repo",
                });
              }}
            >
              <span className="repo-id">
                <span className="repo-name">{r.name}</span>
                <span className="repo-branch">{r.branch}</span>
              </span>
              {changed > 0 && (
                <span
                  className="repo-count"
                  title={`${changed} file${changed > 1 ? "s" : ""} differ from the last commit`}
                >
                  {changed}
                </span>
              )}
            </button>
            {open &&
              (nodes.length ? (
                nodes.map((n) => row(n, r, 1))
              ) : (
                <p className="none pad small">
                  {filtering ? "Nothing matches." : "No markdown here."}
                </p>
              ))}
          </div>
        );
      })}
    </div>
  );
});
