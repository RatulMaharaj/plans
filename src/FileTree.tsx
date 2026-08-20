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
function build(files: PlanFile[], empties: string[] = [], order: string[] = []): Node[] {
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
  /**
   * Where a file's status puts it, when the tree is ordered by status.
   *
   * The vocabulary comes from settings rather than from here — the app reads
   * conventions, it doesn't own one — so "first" means "first in your list".
   * A status nobody declared, and a file with none at all, sort after every
   * status that was: adopting this can then be partial, which it has to be,
   * since most repositories have files that are not plans.
   */
  const rank = (f: File) => {
    const at = order.indexOf((f.file.status ?? "").trim().toLowerCase());
    return at === -1 ? order.length : at;
  };

  /*
   * Folders before files, and within them by name — the order a tree is read
   * in. By status first when asked for, which is the cheap answer to wanting a
   * plans folder in some order other than the alphabet: the status is already
   * read on every file during the walk, so this costs a comparison and no new
   * field. Name is still the tie-break, so the order is stable and two plans
   * with the same status read as they did before.
   */
  const sort = (d: Dir) => {
    d.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      if (a.kind === "file" && b.kind === "file" && order.length) {
        const by = rank(a) - rank(b);
        if (by !== 0) return by;
      }
      return a.name.localeCompare(b.name);
    });
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
  /**
   * The status vocabulary to order files by, or empty to order by name.
   *
   * A list rather than a flag, because "first" can only mean "first in your
   * list" — the statuses are a convention the repository keeps, not a
   * vocabulary the app owns.
   */
  statusOrder: string[];
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
  /** Open a terminal in the repository. */
  onTerminal: (repoPath: string) => void;
  /** A file dragged onto the editor's far edge opens in the split pane. */
  onOpenSplit: (repoPath: string, relPath: string) => void;
  /** dir is repo-relative, "" for the repo root. */
  onNewFile: (repoPath: string, dir: string) => void;
  onRename: (repoPath: string, relPath: string) => void;
  onMoveTo: (repoPath: string, relPath: string) => void;
  onNewFolder: (repoPath: string, dir: string) => void;
  /** Dragged into a folder: dir is "" for the repository root. */
  onMove: (repoPath: string, relPath: string, dir: string) => void;
  /** Dragged into another repository, which is a copy rather than a move. */
  onCopy: (fromRepo: string, relPath: string, toRepo: string, dir: string) => void;
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
  /** Where the pointer went down, before it has moved far enough to be a drag. */
  const pressed = useRef<{
    repo: string;
    path: string;
    kind: "file" | "dir";
    x: number;
    y: number;
  } | null>(null);
  /** Which drop target the pointer is currently over, resolved from the DOM. */
  const target = useRef<{ repo: string; dir: string } | { split: true } | null>(null);
  /** Swallow the click that follows a completed drag, so it doesn't open/toggle. */
  const didDrag = useRef(false);

  /*
   * Dragging on pointer events, not HTML5 drag-and-drop.
   *
   * `dragDropEnabled` is on so files from Finder arrive with real paths —
   * and with it on, Tauri's window takes drag events for native file drops
   * before the page can see them (the bug log has the scar). Pointer events
   * are below all of that: a press, a threshold, `elementFromPoint` to find
   * the folder under the pointer, and a drop on release.
   */
  const dragHandle = (repo: string, path: string, kind: "file" | "dir") => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      pressed.current = { repo, path, kind, x: e.clientX, y: e.clientY };
    },
  });

  const endDrag = () => {
    // Only a drag this tree started gets to turn the drop zone off — the tab
    // strip shares the `tree-drag` switch, and this handler fires on every
    // pointerup whether or not a tree drag was live.
    if (carried.current) document.body.classList.remove("tree-drag");
    carried.current = null;
    pressed.current = null;
    target.current = null;
    setDragging(null);
    setOver(null);
  };

  /**
   * Whether this folder can take what is being dragged.
   *
   * Across repositories is a copy rather than a move — git has no rename that
   * spans two of them, so the destination sees an addition and the original
   * stays put. None of the same-repository guards below apply to that case: a
   * different root cannot be the dragged folder's own ancestor, and "it is
   * already there" means nothing when it is somewhere else entirely. Folders
   * are refused, since copying one raises questions about its contents that
   * moving a plan between repositories does not need answered.
   *
   * Within a repository: not into where it already is, and not into itself or
   * anything inside it, which would ask the filesystem to put a folder inside a
   * folder that is about to move.
   */
  const allowed = (
    it: { repo: string; path: string; kind: "file" | "dir" } | null,
    repoPath: string,
    dir: string,
  ) => {
    if (!it) return false;
    if (it.repo !== repoPath) return it.kind === "file";
    const from = it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/")) : "";
    if (from === dir) return false;
    if (it.kind === "dir" && (dir === it.path || dir.startsWith(`${it.path}/`))) return false;
    return true;
  };

  /** The attributes a folder (or repo root) carries so a drag can find it. */
  const dropSpot = (repoPath: string, dir: string, key: string) => ({
    "data-drop-key": key,
    "data-drop-repo": repoPath,
    "data-drop-dir": dir,
  });

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const start = pressed.current;
      if (!start) return;
      if (!carried.current) {
        // A click is not a drag until it has travelled.
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
        carried.current = { repo: start.repo, path: start.path, kind: start.kind };
        setDragging({ repo: start.repo, path: start.path });
        // The page's split drop zone only takes the pointer while a drag is
        // live — a class on <body> is what turns it on.
        if (start.kind === "file") document.body.classList.add("tree-drag");
        trace("drag start", { path: start.path, kind: start.kind });
      }
      const spot = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)
        ?.closest<HTMLElement>("[data-drop-key], [data-drop-pane]");
      if (spot?.dataset.dropPane === "split" && carried.current.kind === "file") {
        target.current = { split: true };
        setOver(null);
        return;
      }
      const repo = spot?.dataset.dropRepo;
      const dir = spot?.dataset.dropDir;
      if (spot && repo !== undefined && dir !== undefined && allowed(carried.current, repo, dir)) {
        target.current = { repo, dir };
        setOver(spot.dataset.dropKey ?? null);
      } else {
        target.current = null;
        setOver(null);
      }
    };
    const up = () => {
      const it = carried.current;
      const t = target.current;
      if (it && t) {
        didDrag.current = true;
        if ("split" in t) {
          trace("drop", { onto: "<split>", carrying: it.path });
          p.onOpenSplit(it.repo, it.path);
        } else {
          trace("drop", { onto: t.dir || "<root>", carrying: it.path });
          if (it.repo === t.repo) p.onMove(it.repo, it.path, t.dir);
          else p.onCopy(it.repo, it.path, t.repo, t.dir);
        }
      } else if (it) {
        didDrag.current = true;
      }
      endDrag();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && carried.current) endDrag();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.onMove, p.onCopy, p.onOpenSplit]);


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
      out[r.path] = { nodes: squash(build(kept, empties, p.statusOrder)), kept };
    }
    return out;
  }, [p.repos, p.filesByRepo, p.filter, p.emptyDirs, p.statusOrder]);

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
            {...dragHandle(repo.path, node.path, "dir")}
            {...dropSpot(repo.path, node.path, key)}
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
        {...dragHandle(repo.path, node.path, "file")}
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
    <div
      className="tree"
      // A completed drag ends on a row, and the click that follows would open
      // or toggle it — swallowed here, once, at the capture phase.
      onClickCapture={(e) => {
        if (!didDrag.current) return;
        didDrag.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
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

          {menu.kind === "repo" && (
            <button
              className="ctx-item"
              onClick={() => act(() => p.onTerminal(menu.repo))}
            >
              Open in Terminal
            </button>
          )}

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
              {...dropSpot(r.path, "", `${r.path}::root`)}
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
