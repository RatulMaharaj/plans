/**
 * The file tree.
 *
 * Repositories are the top level; every markdown file in each one hangs below
 * it in its real folder structure. The git mark rides on each row, so the tree
 * carries state ambiently and the git panel is only needed to *act*.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { trace } from "./perf";
import { statusTone } from "./matter";
import { confirmed } from "./confirm";
import type { PlanFile, RepoInfo } from "./api";

export type Mark = "clean" | "new" | "mod" | "staged" | "conflict";

export const GLYPH: Record<Mark, string> = {
  clean: "·",
  new: "+",
  mod: "~",
  staged: "▲",
  conflict: "!",
};
export const MARK_WORD: Record<Mark, string> = {
  clean: "committed",
  new: "new",
  mod: "edited",
  staged: "staged",
  conflict: "conflicted",
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

/**
 * Fold a flat list of repo-relative paths into nested folders.
 *
 * `empties` are folders that exist on disk but hold no markdown yet. A tree
 * built only from files cannot show them, and a folder that vanishes the moment
 * you make it is worse than not being able to make one.
 */
function build(files: PlanFile[], empties: string[] = []): Node[] {
  const root: Dir = { kind: "dir", name: "", path: "", children: [] };

  const folder = (path: string): Dir => {
    const parts = path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const at = parts.slice(0, i + 1).join("/");
      let next = cur.children.find((c): c is Dir => c.kind === "dir" && c.path === at);
      if (!next) {
        next = { kind: "dir", name: parts[i], path: at, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
    return cur;
  };
  for (const e of empties) if (e) folder(e);
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
const RANK: Record<Mark, number> = { conflict: 4, mod: 3, new: 2, staged: 1, clean: 0 };

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
  /**
   * Start the agent on this plan. Absent when there is no agent installed —
   * the menu then simply does not carry the item, rather than carrying one
   * that fails when pressed.
   */
  onHandOff?: (repoPath: string, relPath: string) => void;
  onDelete: (repoPath: string, relPath: string) => void;
  /** Delete a folder and everything inside it; App asks first if need be. */
  onDeleteDir: (repoPath: string, relPath: string) => void;
  /** Show the file or folder in Finder. relPath "" is the repository itself. */
  onReveal: (repoPath: string, relPath: string) => void;
  /** dir is repo-relative, "" for the repo root. */
  onNewFile: (repoPath: string, dir: string) => void;
  onRename: (repoPath: string, relPath: string) => void;
  onMoveTo: (repoPath: string, relPath: string) => void;
  onNewFolder: (repoPath: string, dir: string) => void;
  /** Dragged into a folder: dir is "" for the repository root. */
  onMove: (repoPath: string, relPath: string, dir: string) => void;
  /** Folders that exist on disk but hold no markdown yet, per repository. */
  emptyDirs: Record<string, string[]>;
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
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * Where the menu actually goes, once its size is known.
   *
   * The pointer is only a request: a right-click near the bottom of a long
   * tree would put a 200px menu below the window and cut it off. Measured
   * after render because the height depends on which items this row gets —
   * a file's menu is taller than a folder's.
   */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) return setAt(null);
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    // Flip above the pointer when there is no room below, then clamp — a menu
    // taller than the window still has to start somewhere on it.
    const y =
      menu.y + height + pad > window.innerHeight ? menu.y - height : menu.y;
    const x = menu.x + width + pad > window.innerWidth ? menu.x - width : menu.x;
    setAt({
      x: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
    });
  }, [menu]);
  /**
   * What is being dragged, and where it is hovering.
   *
   * Held in a ref as well as in state: a dragover fires long before React has
   * re-rendered with new state, and the highlight has to answer immediately.
   * The state exists only to redraw.
   *
   * The drag also carries a private MIME type, so a drop can be identified as
   * ours even if the ref has been lost — WebKit will not let a dragover handler
   * read the value being dragged, but it will say which types are present.
   */
  const carried = useRef<{ repo: string; path: string; kind: "file" | "dir" } | null>(null);
  const [dragging, setDragging] = useState<{ repo: string; path: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** dragleave fires when the pointer crosses a child, so leaves are counted. */
  const depth = useRef(0);

  const MIME = "application/x-plans-move";

  const startDrag = (
    e: React.DragEvent,
    repo: string,
    path: string,
    kind: "file" | "dir",
  ) => {
    e.stopPropagation();
    carried.current = { repo, path, kind };
    setDragging({ repo, path });
    depth.current = 0;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(MIME, [repo, path, kind].join("\n"));
    trace("drag start", { path, kind });
    // Something usable by other applications, too.
    e.dataTransfer.setData("text/plain", path);
  };

  const endDrag = () => {
    carried.current = null;
    depth.current = 0;
    setDragging(null);
    setOver(null);
  };

  /**
   * Whether this folder can take what is being dragged.
   *
   * Not across repositories — that is a copy, not a move, and git would see a
   * deletion and an addition rather than a rename. Not into where it already
   * is. And not into itself or anything inside it, which would ask the
   * filesystem to put a folder inside a folder that is about to move.
   */
  const allowed = (
    it: { repo: string; path: string; kind: "file" | "dir" } | null,
    repoPath: string,
    dir: string,
  ) => {
    if (!it || it.repo !== repoPath) return false;
    const from = it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/")) : "";
    if (from === dir) return false;
    if (it.kind === "dir" && (dir === it.path || dir.startsWith(`${it.path}/`))) return false;
    return true;
  };

  const dropHandlers = (repoPath: string, dir: string, key: string) => ({
    onDragEnter: (e: React.DragEvent) => {
      if (!allowed(carried.current, repoPath, dir)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current += 1;
      setOver(key);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!allowed(carried.current, repoPath, dir)) return;
      // Both the preventDefault and the dropEffect: without either, WebKit
      // shows a "no drop" cursor and never fires a drop at all.
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (over !== key) setOver(key);
    },
    onDragLeave: () => {
      depth.current -= 1;
      if (depth.current <= 0) {
        depth.current = 0;
        setOver((cur) => (cur === key ? null : cur));
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const raw = e.dataTransfer.getData(MIME);
      const it =
        carried.current ??
        (raw
          ? (() => {
              const [repo, path, kind] = raw.split("\n");
              return { repo, path, kind: kind as "file" | "dir" };
            })()
          : null);
      endDrag();
      trace("drop", { onto: dir || "<root>", carrying: it?.path ?? null });
      if (allowed(it, repoPath, dir) && it) p.onMove(it.repo, it.path, dir);
    },
  });


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
      // A filter is asking about files, so empty folders step aside for it.
      const empties = q ? [] : (p.emptyDirs[r.path] ?? []);
      out[r.path] = { nodes: squash(build(kept, empties)), kept };
    }
    return out;
  }, [p.repos, p.filesByRepo, p.filter, p.emptyDirs]);

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
            className={`row dir ${mark} ${over === key ? "over" : ""} ${
              dragging?.repo === repo.path && dragging.path === node.path ? "lifted" : ""
            }`}
            style={pad}
            draggable
            onDragStart={(e) => startDrag(e, repo.path, node.path, "dir")}
            onDragEnd={endDrag}
            {...dropHandlers(repo.path, node.path, key)}
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
        className={`row file ${mark} ${active ? "active" : ""} ${
          dragging?.repo === repo.path && dragging.path === node.path ? "lifted" : ""
        }`}
        style={pad}
        draggable
        onDragStart={(e) => startDrag(e, repo.path, node.path, "file")}
        onDragEnd={endDrag}
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
        {/* The status: from the file's frontmatter, as a quiet tinted dot. */}
        {node.file.status && (
          <span
            className={`status-dot tone-${statusTone(node.file.status)}`}
            title={node.file.status}
            aria-hidden
          />
        )}
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
          ref={menuRef}
          // Hidden for the frame it takes to measure: a menu that appears at
          // the pointer and then jumps is worse than one that appears placed.
          style={{ left: at?.x ?? menu.x, top: at?.y ?? menu.y, visibility: at ? undefined : "hidden" }}
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
              {p.onHandOff && (
                <button
                  className="ctx-item"
                  onClick={() => act(() => p.onHandOff!(menu.repo, menu.path))}
                >
                  Hand off to agent
                </button>
              )}
            </>
          ) : (
            <button
              className="ctx-item"
              onClick={() => act(() => p.onNewFile(menu.repo, menu.path))}
            >
              New file here
            </button>
          )}

          {menu.kind !== "file" && (
            <button
              className="ctx-item"
              onClick={() => act(() => p.onNewFolder(menu.repo, menu.path))}
            >
              New folder here
            </button>
          )}

          {menu.kind === "file" && (
            <>
              <button
                className="ctx-item"
                onClick={() => act(() => p.onRename(menu.repo, menu.path))}
              >
                Rename…
              </button>
              <button
                className="ctx-item"
                onClick={() => act(() => p.onMoveTo(menu.repo, menu.path))}
              >
                Move to…
              </button>
            </>
          )}

          <button
            className="ctx-item"
            onClick={() => act(() => void navigator.clipboard.writeText(menu.path))}
          >
            Copy path
          </button>

          <button
            className="ctx-item"
            onClick={() => act(() => p.onReveal(menu.repo, menu.path))}
          >
            Reveal in Finder
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

          {menu.kind === "dir" && (
            <>
              <span className="ctx-rule" />
              <button
                className="ctx-item warn"
                onClick={() => act(() => p.onDeleteDir(menu.repo, menu.path))}
              >
                Delete folder
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
                    void confirmed(
                      "Forget this repository? Nothing on disk is touched.",
                      { ok: "Forget" },
                    ).then((yes) => {
                      if (yes) p.onForgetRepo(menu.repo);
                    });
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
              className={`row repo ${r.path === p.activeRepoPath ? "current" : ""} ${
                over === `${r.path}::root` ? "over" : ""
              }`}
              {...dropHandlers(r.path, "", `${r.path}::root`)}
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
