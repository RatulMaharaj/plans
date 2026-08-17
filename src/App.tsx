import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type GitStatus, type PlanFile, type RepoInfo } from "./api";
import { Editor } from "./Editor";
import { GitPanel } from "./GitPanel";
import { DiffView } from "./DiffView";
import { SettingsPage } from "./SettingsPage";
import { Palette } from "./Palette";
import { Dropdown } from "./Dropdown";
import { FileTree, displayName, MARK_WORD, type Mark } from "./FileTree";
import { FrontmatterSheet } from "./Frontmatter";
import { NameSheet } from "./NameSheet";
import { TextPrompt } from "./TextPrompt";
import { SourceView } from "./SourceView";
import { PerfHud } from "./PerfHud";
import { start, tick } from "./perf";
import { htmlBridge, type HtmlEdit } from "./html-view";
import { joinFrontmatter, splitFrontmatter } from "./matter";
import {
  applySettings,
  DEFAULTS,
  loadSettings,
  RANGES,
  saveSettings,
  type Settings,
} from "./settings";
import "./App.css";

const KEY = {
  repos: "plans.repos.v1",
  last: "plans.last.v1",
  tabs: "plans.tabs.v1",
};

/** An open buffer. The text lives on disk; this is only what is on the bar. */
type Tab = { repo: string; path: string };

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Cheap equality for polled data, so an unchanged poll costs one comparison
 * rather than a re-render of the whole tree.
 */
function sameFiles(
  a: Record<string, PlanFile[]>,
  b: Record<string, PlanFile[]>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (x[i].relPath !== y[i].relPath || x[i].modified !== y[i].modified) return false;
    }
  }
  return true;
}

function sameStatus(
  a: Record<string, GitStatus>,
  b: Record<string, GitStatus>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y) return false;
    if (x.branch !== y.branch || x.ahead !== y.ahead || x.behind !== y.behind) return false;
    if (x.entries.length !== y.entries.length) return false;
    for (let i = 0; i < x.entries.length; i++) {
      const p = x.entries[i];
      const q = y.entries[i];
      if (p.path !== q.path || p.index !== q.index || p.worktree !== q.worktree) return false;
    }
  }
  return true;
}

type Toast = { text: string; kind: "info" | "error" } | null;
type View = "write" | "source" | "diff" | "settings";


export default function App() {
  // Counts renders of the whole app, which is the cost a keystroke used to pay.
  tick("render App");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  // Every open repo is in the tree at once, so files and status are per-repo.
  const [filesByRepo, setFilesByRepo] = useState<Record<string, PlanFile[]>>({});
  const [statusByRepo, setStatusByRepo] = useState<Record<string, GitStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  /** The prose only — frontmatter is held apart in `matter`. */
  const [content, setContent] = useState("");
  const [matter, setMatter] = useState<string | null>(null);
  const [docKey, setDocKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [view, setView] = useState<View>("write");
  const [epoch, setEpoch] = useState(0);
  const [palette, setPalette] = useState<null | { commands: boolean }>(null);
  /** Zen: the page alone. Deliberately not persisted — it's a mood, not a setting. */
  const [zen, setZen] = useState(false);
  const [perf, setPerf] = useState(false);
  const [matterOpen, setMatterOpen] = useState(false);
  /** Where a new file is about to be created, while the name is being asked. */
  const [naming, setNaming] = useState<null | { repo: string; dir: string }>(null);
  /**
   * Open buffers, in the order they were opened. Switching writes any pending
   * edit and re-reads from disk, so a tab is a bookmark rather than a second
   * copy of the file — there is only ever one buffer, and it is the file.
   */
  const [tabs, setTabs] = useState<Tab[]>(() => stored<Tab[]>(KEY.tabs, []));
  /** A one-line question waiting on an answer: branch name, commit message. */
  const [asking, setAsking] = useState<null | {
    title: string;
    placeholder?: string;
    note?: string;
    confirm: string;
    multiline?: boolean;
    /** Prefilled, for a rename or anything else that edits what exists. */
    initial?: string;
    run: (value: string) => void;
  }>(null);
  const [branches, setBranches] = useState<string[]>([]);
  /** Every folder in the repository a new file is being placed in. */
  const folderChoices = useMemo(() => {
    if (!naming) return [];
    const seen = new Set<string>();
    for (const f of filesByRepo[naming.repo] ?? []) {
      const parts = f.relPath.split("/");
      for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join("/"));
    }
    return [...seen].sort();
  }, [naming, filesByRepo]);

  /** A fragment of HTML open for editing, or null. */
  const [htmlEdit, setHtmlEdit] = useState<HtmlEdit | null>(null);
  /**
   * The buffer model, in the manner of vim: the file is never locked, and what
   * we hold is a copy taken at `stamp`. Anything else — an agent in a terminal,
   * another editor — may write underneath us. We notice rather than prevent.
   */
  const stamp = useRef<string | null>(null);
  /**
   * True while a write is in flight. The watcher polls the file's fingerprint,
   * and our own save changes it — without this it can read the new hash before
   * `stamp` has been updated and report a conflict against ourselves.
   */
  const writing = useRef(false);
  /**
   * The frontmatter block as read, and whether the file ended in a newline.
   * Both are restored on write: the markdown serialiser drops the trailing
   * newline, so without this every file gains a "\ No newline at end of file"
   * the first time it is saved.
   */
  const original = useRef<{ matter: string | null; raw: string; eol: boolean }>({
    matter: null,
    raw: "",
    eol: true,
  });
  const [conflict, setConflict] = useState<null | { theirs: string }>(null);

  const activeRepo = useMemo(
    () => repos.find((r) => r.path === activeRepoPath) ?? null,
    [repos, activeRepoPath],
  );

  const status = activeRepoPath ? (statusByRepo[activeRepoPath] ?? null) : null;

  const notify = useCallback((text: string, kind: "info" | "error" = "info") => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), kind === "error" ? 6000 : 2200);
  }, []);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  // Double-clicking any rendered HTML asks to edit its source.
  useEffect(() => {
    htmlBridge.request = setHtmlEdit;
    return () => {
      htmlBridge.request = null;
    };
  }, []);

  // --- boot ----------------------------------------------------------------
  useEffect(() => {
    const paths = stored<string[]>(KEY.repos, []);
    if (!paths.length) return;
    Promise.all(paths.map((p) => api.openRepo(p).catch(() => null))).then((rs) => {
      const ok = rs.filter(Boolean) as RepoInfo[];
      setRepos(ok);
      const last = stored<string | null>(KEY.last, null);
      const active = ok.find((r) => r.path === last)?.path ?? ok[0]?.path ?? null;
      setActiveRepoPath(active);
      // Open the repository being worked in, so the app starts with its files
      // in view rather than with a collapsed row and nothing to read.
      if (active) setExpanded((prev) => new Set(prev).add(`${active}::`));
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(KEY.repos, JSON.stringify(repos.map((r) => r.path)));
  }, [repos]);

  useEffect(() => {
    localStorage.setItem(KEY.tabs, JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    if (activeRepoPath) localStorage.setItem(KEY.last, JSON.stringify(activeRepoPath));
  }, [activeRepoPath]);

  // --- data ----------------------------------------------------------------
  // "" is the repo root — every markdown file in the repository, wherever it
  // lives. The Rust side skips .git, node_modules, target and friends.
  const refreshFiles = useCallback(async () => {
    const done = start("poll files");
    // One repository at a time. Four parallel walks take every core between
    // them, which is exactly the wrong thing to do behind someone's typing.
    const got: (readonly [string, PlanFile[]])[] = [];
    for (const r of repos) {
      try {
        got.push([r.path, await api.listPlans(r.path, [""], settings.showIgnored)] as const);
      } catch {
        got.push([r.path, []] as const);
      }
    }
    /**
     * Keep the previous object when nothing moved.
     *
     * This runs every few seconds. Replacing state unconditionally meant the
     * tree — thousands of nodes in a large repository — was rebuilt, re-sorted
     * and re-rendered on every poll, for no change at all.
     */
    setFilesByRepo((prev) => {
      const next = Object.fromEntries(got);
      return sameFiles(prev, next) ? prev : next;
    });
    done();
  }, [repos, settings.showIgnored]);

  /** One repository's status, for when only one thing can have changed. */
  const refreshStatusFor = useCallback(async (repo: string) => {
    try {
      const st = await api.gitStatus(repo, []);
      setStatusByRepo((prev) =>
        sameStatus({ [repo]: prev[repo] }, { [repo]: st }) ? prev : { ...prev, [repo]: st },
      );
    } catch {
      /* the next poll will pick it up */
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const got: (readonly [string, GitStatus | null])[] = [];
    for (const r of repos) {
      try {
        got.push([r.path, await api.gitStatus(r.path, [])] as const);
      } catch {
        got.push([r.path, null] as const);
      }
    }
    setStatusByRepo((prev) => {
      const next = Object.fromEntries(
        got.filter((g): g is readonly [string, GitStatus] => !!g[1]),
      );
      return sameStatus(prev, next) ? prev : next;
    });
  }, [repos]);

  useEffect(() => {
    void refreshFiles();
    void refreshStatus();
  }, [refreshFiles, refreshStatus]);

  /**
   * How often each kind of work runs.
   *
   * Measured: walking a repository and asking git for its status are cheap on
   * their own, but doing both for every open repository at once, every few
   * seconds, saturates the machine — and a saturated machine is a slow window.
   *
   * So: git status for the repository being looked at on the short interval,
   * the others rarely; the file walk rarely for everyone, since files appearing
   * is much less common than their contents changing.
   */
  const SLOW = 6;

  // Files written by Claude Code in a terminal should turn up on their own.
  useEffect(() => {
    if (settings.watchSeconds <= 0) return;
    let n = 0;
    const t = setInterval(() => {
      if (busy) return;
      n += 1;
      // The active repository, every tick: this is what is on screen.
      if (activeRepoPath) void refreshStatusFor(activeRepoPath);
      // Everything else, and the walk for new files, every SLOW ticks.
      if (n % SLOW === 0) {
        void refreshStatus();
        void refreshFiles();
      }
    }, settings.watchSeconds * 1000);
    return () => clearInterval(t);
  }, [
    refreshFiles,
    refreshStatus,
    refreshStatusFor,
    activeRepoPath,
    busy,
    settings.watchSeconds,
  ]);

  /** "<repo>::<path>" -> mark, so the tree carries git state with the panel closed. */
  const marks = useMemo(() => {
    const m = new Map<string, Mark>();
    for (const [repo, st] of Object.entries(statusByRepo)) {
      for (const e of st.entries) {
        const k = `${repo}::${e.path}`;
        if (e.index !== " " && e.index !== "?") m.set(k, "staged");
        else if (e.worktree === "?") m.set(k, "new");
        else if (e.worktree !== " ") m.set(k, "mod");
      }
    }
    return m;
  }, [statusByRepo]);

  const changeCount = status?.entries.length ?? 0;

  /**
   * Branches, on demand. Measured at over three seconds on a large repository,
   * which is not something to do on a timer for a list nobody has opened.
   */
  useEffect(() => {
    if (!activeRepoPath || (!palette && !settings.showGit)) return;
    let live = true;
    api
      .gitBranches(activeRepoPath)
      .then((b) => live && setBranches(b.branches))
      .catch(() => live && setBranches([]));
    return () => {
      live = false;
    };
  }, [activeRepoPath, status?.branch, epoch, palette, settings.showGit]);

  // --- repos ---------------------------------------------------------------
  const addRepo = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose a repository",
    });
    if (typeof picked !== "string") return;
    try {
      const info = await api.openRepo(picked);
      setRepos((prev) =>
        prev.some((r) => r.path === info.path) ? prev : [...prev, info],
      );
      setActiveRepoPath(info.path);
      setExpanded((prev) => new Set(prev).add(`${info.path}::`));
    } catch (e) {
      notify(String(e), "error");
    }
  }, [notify]);

  const forgetRepo = useCallback(
    (path: string) => {
      setRepos((prev) => prev.filter((r) => r.path !== path));
      setActiveRepoPath((cur) => (cur === path ? null : cur));
      if (activeRepoPath === path) {
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
    },
    [activeRepoPath],
  );

  /**
   * Dragging the sidebar's edge. Pointer capture rather than window listeners,
   * so the drag survives the pointer crossing the editor or leaving the window.
   */
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const r = RANGES.treeWidth;
      const move = (ev: PointerEvent) => {
        set({ treeWidth: Math.min(r.max, Math.max(r.min, Math.round(ev.clientX))) });
      };
      const done = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", done);
        el.removeEventListener("pointercancel", done);
        document.body.classList.remove("resizing");
      };
      document.body.classList.add("resizing");
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", done);
      el.addEventListener("pointercancel", done);
    },
    [set],
  );

  const setOpen = useCallback((keys: string[], open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of keys) open ? next.add(k) : next.delete(k);
      return next;
    });
  }, []);

  const toggleNode = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // --- editing -------------------------------------------------------------
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ repo: string; path: string; text: string } | null>(null);

  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    writing.current = true;
    try {
      // Conditional on the version we loaded: if the file moved under us the
      // write is refused rather than clobbering whatever arrived.
      stamp.current = await api.writePlan(p.repo, p.path, p.text, stamp.current ?? undefined);
      setDirty(false);
      setSavedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
      // Only the repository that was written to. Re-reading every open repo's
      // status on each autosave is a lot of work for one file's worth of news.
      void refreshStatusFor(p.repo);
    } catch (e) {
      if (String(e).includes("STALE")) {
        // Put the edit back so no keystroke is lost while the reader decides.
        pending.current = p;
        const theirs = await api.readPlan(p.repo, p.path).then(
          (r) => r.content,
          () => "",
        );
        setConflict({ theirs });
        return;
      }
      notify(String(e), "error");
    } finally {
      writing.current = false;
    }
  }, [notify, refreshStatus]);

  const onChange = useCallback(
    (markdown: string) => {
      if (!activeRepo || !activePath) return;
      setContent(markdown);
      setDirty(true);
      pending.current = {
        repo: activeRepo.path,
        path: activePath,
        text: assemble(matter, markdown),
      };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // "onBlur" and "manual" keep the edit pending; switching files or
      // quitting still flushes it, so nothing is lost either way.
      if (settings.autosave === "afterDelay") {
        saveTimer.current = window.setTimeout(
          () => void flush(),
          Math.round(settings.autosaveDelay * 1000),
        );
      }
    },
    [activeRepo, activePath, flush, matter, settings.autosave, settings.autosaveDelay],
  );

  /**
   * The whole file as text, frontmatter and all — what is actually on disk.
   * Editing it re-splits, so the other two views stay in step.
   */
  const assemble = useCallback(
    (m: string | null, body: string) => {
      const text = joinFrontmatter(m, body, original.current);
      // Files end with a newline; the serialiser does not always agree.
      return original.current.eol && text && !text.endsWith("\n") ? `${text}\n` : text;
    },
    [],
  );

  const source = useMemo(() => assemble(matter, content), [assemble, matter, content]);

  const onSourceChange = useCallback(
    (text: string) => {
      if (!activeRepo || !activePath) return;
      const split = settings.showFrontmatter
        ? splitFrontmatter(text)
        : { matter: null, body: text };
      setMatter(split.matter);
      setContent(split.body);
      setDirty(true);
      pending.current = { repo: activeRepo.path, path: activePath, text };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (settings.autosave === "afterDelay") {
        saveTimer.current = window.setTimeout(
          () => void flush(),
          Math.round(settings.autosaveDelay * 1000),
        );
      }
    },
    [
      activeRepo,
      activePath,
      flush,
      settings.showFrontmatter,
      settings.autosave,
      settings.autosaveDelay,
    ],
  );

  /**
   * Switching views.
   *
   * Coming back from Source only rebuilds the rich editor if the text actually
   * changed there. Rebuilding is expensive — the document is reparsed, every
   * code block gets a fresh CodeMirror, every diagram re-renders — and doing it
   * on a glance at the source made switching feel slow for no reason.
   */
  const sourceOnEntry = useRef<string | null>(null);

  const goto = useCallback(
    (next: View) => {
      setView((prev) => {
        if (next === "source" && prev !== "source") sourceOnEntry.current = source;
        if (next === "write" && prev === "source" && activePath) {
          const changed = sourceOnEntry.current !== null && sourceOnEntry.current !== source;
          if (changed) setDocKey(`${activeRepoPath}::${activePath}::${Date.now()}`);
          sourceOnEntry.current = null;
        }
        return next;
      });
    },
    [activePath, activeRepoPath, source],
  );

  /** Editing the metadata block saves on the same terms as editing the prose. */
  const onMatterChange = useCallback(
    (next: string | null) => {
      if (!activeRepo || !activePath) return;
      setMatter(next);
      setDirty(true);
      pending.current = {
        repo: activeRepo.path,
        path: activePath,
        text: assemble(next, content),
      };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (settings.autosave === "afterDelay") {
        saveTimer.current = window.setTimeout(
          () => void flush(),
          Math.round(settings.autosaveDelay * 1000),
        );
      }
    },
    [activeRepo, activePath, content, flush, settings.autosave, settings.autosaveDelay],
  );

  // "onBlur": the window losing focus is the cue, as in an IDE.
  useEffect(() => {
    if (settings.autosave !== "onBlur") return;
    const onBlur = () => void flush();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [settings.autosave, flush]);

  // Never lose a pending edit to a quit or reload.
  useEffect(() => {
    const onLeave = () => void flush();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [flush]);

  /** Opening a file in another repository makes that repository the active one. */
  const openFile = useCallback(
    async (repoPath: string, relPath: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flush();
      try {
        const { content: text, stamp: at } = await api.readPlan(repoPath, relPath);
        stamp.current = at;
        setConflict(null);
        // With the block turned off the YAML simply stays in the prose, where
        // the editor can still reach it — hidden and uneditable would be worse.
        const split = settings.showFrontmatter
          ? splitFrontmatter(text)
          : { matter: null, body: text, raw: "" };
        original.current = {
          matter: split.matter,
          raw: split.raw,
          eol: /\n$/.test(text),
        };
        setActiveRepoPath(repoPath);
        setActivePath(relPath);
        setMatter(split.matter);
        setContent(split.body);
        setDocKey(`${repoPath}::${relPath}::${Date.now()}`);
        setDirty(false);
        setSavedAt(null);
        setMatterOpen(false);
        setTabs((prev) =>
          prev.some((t) => t.repo === repoPath && t.path === relPath)
            ? prev
            : [...prev, { repo: repoPath, path: relPath }],
        );
        setView((v) => (v === "settings" ? "write" : v));
        // Open every folder on the way down to it.
        setExpanded((prev) => {
          const next = new Set(prev).add(`${repoPath}::`);
          const parts = relPath.split("/");
          for (let i = 1; i < parts.length; i++) {
            next.add(`${repoPath}::${parts.slice(0, i).join("/")}`);
          }
          return next;
        });
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [flush, notify, settings.showFrontmatter],
  );

  /**
   * Watch the open file for writes from anywhere else.
   *
   * Clean buffer: take the new version, since there is nothing of yours to
   * lose. Dirty buffer: say so and let the reader choose — never silently.
   */
  useEffect(() => {
    if (settings.watchSeconds <= 0 || !activeRepoPath || !activePath) return;
    const t = setInterval(async () => {
      if (busy || conflict || writing.current || pending.current) return;
      const at = await api.statPlan(activeRepoPath, activePath).catch(() => null);
      if (!at || at === stamp.current) return;
      if (dirty || pending.current) {
        const theirs = await api
          .readPlan(activeRepoPath, activePath)
          .then((r) => r.content, () => "");
        setConflict({ theirs });
      } else {
        await openFile(activeRepoPath, activePath);
        notify("Reloaded — this file changed on disk");
      }
    }, Math.max(1, settings.watchSeconds) * 1000);
    return () => clearInterval(t);
  }, [
    activeRepoPath,
    activePath,
    dirty,
    busy,
    conflict,
    settings.watchSeconds,
    openFile,
    notify,
  ]);

  /** Close a buffer and step to whichever tab was next to it. */
  const closeTab = useCallback(
    async (repo: string, path: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flush();
      const i = tabs.findIndex((t) => t.repo === repo && t.path === path);
      const rest = tabs.filter((t) => !(t.repo === repo && t.path === path));
      setTabs(rest);
      if (repo !== activeRepoPath || path !== activePath) return;
      const next = rest[Math.min(i, rest.length - 1)];
      setConflict(null);
      setMatterOpen(false);
      if (next) {
        await openFile(next.repo, next.path);
      } else {
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
    },
    [tabs, flush, activeRepoPath, activePath, openFile],
  );

  /** Resolving a conflict: keep what you wrote, or take what arrived. */
  const resolveConflict = useCallback(
    async (choice: "mine" | "theirs") => {
      if (!activeRepoPath || !activePath) return;
      if (choice === "theirs") {
        pending.current = null;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        setConflict(null);
        setDirty(false);
        await openFile(activeRepoPath, activePath);
        notify("Took the version from disk");
        return;
      }
      // Adopt the on-disk stamp so the next write is allowed through, then
      // write our buffer over it.
      stamp.current = await api.statPlan(activeRepoPath, activePath).catch(() => null);
      setConflict(null);
      await flush();
      notify("Kept your version");
    },
    [activeRepoPath, activePath, openFile, flush, notify],
  );

  /**
   * Re-read everything from disk: repo metadata, file lists, git status, and
   * the open file. Pending edits are written first so a reload never loses them.
   */
  const reloadAll = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await flush();
    try {
      const fresh = await Promise.all(
        repos.map((r) => api.openRepo(r.path).catch(() => r)),
      );
      setRepos(fresh);
      await Promise.all([refreshFiles(), refreshStatus()]);
      if (activeRepoPath && activePath) {
        const { content: text, stamp: at } = await api.readPlan(activeRepoPath, activePath);
        stamp.current = at;
        setConflict(null);
        const split = settings.showFrontmatter
          ? splitFrontmatter(text)
          : { matter: null, body: text, raw: "" };
        original.current = {
          matter: split.matter,
          raw: split.raw,
          eol: /\n$/.test(text),
        };
        setMatter(split.matter);
        setContent(split.body);
        setDocKey(`${activeRepoPath}::${activePath}::${Date.now()}`);
        setDirty(false);
      }
      setEpoch((n) => n + 1);
      notify("Reloaded");
    } catch (e) {
      notify(String(e), "error");
    }
  }, [
    repos,
    flush,
    refreshFiles,
    refreshStatus,
    activeRepoPath,
    activePath,
    settings.showFrontmatter,
    notify,
  ]);

  // Toggling the setting moves the block between the panel and the prose.
  const wasSplit = useRef(settings.showFrontmatter);
  useEffect(() => {
    if (wasSplit.current === settings.showFrontmatter) return;
    wasSplit.current = settings.showFrontmatter;
    if (!activePath) return;
    if (settings.showFrontmatter) {
      const split = splitFrontmatter(content);
      setMatter(split.matter);
      setContent(split.body);
    } else if (matter !== null) {
      setContent(joinFrontmatter(matter, content));
      setMatter(null);
    }
    setDocKey(`${activeRepoPath}::${activePath}::${Date.now()}`);
  }, [settings.showFrontmatter, activePath, activeRepoPath, content, matter]);

  /** ⌘N and the palette: a new file beside whatever is open. */
  const newPlan = useCallback(() => {
    if (!activeRepo) return;
    setNaming({
      repo: activeRepo.path,
      dir: activePath?.includes("/")
        ? activePath.slice(0, activePath.lastIndexOf("/"))
        : "",
    });
  }, [activeRepo, activePath]);

  const createFile = useCallback(
    async (repoPath: string, relPath: string, title: string) => {
      setNaming(null);
      try {
        await api.createPlan(repoPath, relPath, title);
        await refreshFiles();
        await openFile(repoPath, relPath);
        void refreshStatus();
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [refreshFiles, refreshStatus, openFile, notify],
  );

  /**
   * The tree's right-click actions. Each takes its own repo, since the tree
   * shows every open repository at once, not only the active one.
   */
  const fileAction = useCallback(
    (repoPath: string, label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      fn()
        .then(() => notify(label))
        .catch((e) => notify(String(e), "error"))
        .finally(async () => {
          setBusy(null);
          setEpoch((n) => n + 1);
          await refreshStatus();
          await refreshFiles();
        });
      void repoPath;
    },
    [notify, refreshStatus, refreshFiles],
  );

  const discardFile = useCallback(
    async (repoPath: string, relPath: string, mark: Mark) => {
      // An untracked file has no committed version to return to — discarding
      // it means removing it, so it gets the harsher question.
      const gone = mark === "new";
      const ask = gone
        ? `${relPath} has never been committed. Discarding deletes it. Continue?`
        : `Throw away your changes to ${relPath} and return it to the last commit?`;
      if (!window.confirm(ask)) return;
      if (repoPath === activeRepoPath && relPath === activePath) {
        // Don't let a pending autosave write the old text back afterwards.
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pending.current = null;
        setDirty(false);
      }
      fileAction(repoPath, gone ? "File deleted" : "Reset to last commit", async () => {
        if (gone) await api.deletePlan(repoPath, relPath);
        else await api.gitDiscard(repoPath, [relPath]);
      });
      if (repoPath === activeRepoPath && relPath === activePath) {
        if (gone) {
          setActivePath(null);
          setContent("");
          setMatter(null);
        } else {
          await openFile(repoPath, relPath);
        }
      }
    },
    [activeRepoPath, activePath, fileAction, openFile],
  );

  const deleteFile = useCallback(
    async (repoPath: string, relPath: string) => {
      if (!window.confirm(`Delete ${relPath} from disk?`)) return;
      if (repoPath === activeRepoPath && relPath === activePath) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pending.current = null;
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
      fileAction(repoPath, "Deleted", () => api.deletePlan(repoPath, relPath));
    },
    [activeRepoPath, activePath, fileAction],
  );

  /** Stable handlers, so a memoised tree is not defeated by new closures. */
  const stageOne = useCallback(
    (r: string, f: string) => fileAction(r, "Staged", () => api.gitStage(r, [f])),
    [fileAction],
  );
  const unstageOne = useCallback(
    (r: string, f: string) => fileAction(r, "Unstaged", () => api.gitUnstage(r, [f])),
    [fileAction],
  );
  const discardOne = useCallback(
    (r: string, f: string, m: Mark) => void discardFile(r, f, m),
    [discardFile],
  );
  const deleteOne = useCallback((r: string, f: string) => void deleteFile(r, f), [deleteFile]);
  const openOne = useCallback((r: string, f: string) => void openFile(r, f), [openFile]);

  /**
   * Rename, which is also how a file moves: the answer is a path, so typing a
   * folder into it puts the file there. Git follows a rename on its own.
   */
  const renameFile = useCallback(
    (repoPath: string, relPath: string) => {
      setAsking({
        title: "Rename",
        placeholder: relPath,
        initial: relPath,
        note: "A path, not just a name — type a folder into it to move the file.",
        confirm: "Rename",
        run: (next) => {
          const to = next.endsWith(".md") || next.endsWith(".markdown") ? next : `${next}.md`;
          if (to === relPath) return;
          fileAction(repoPath, "Renamed", async () => {
            await api.renamePlan(repoPath, relPath, to);
            if (repoPath === activeRepoPath && relPath === activePath) {
              // Follow the file, and take its tab with it.
              pending.current = null;
              if (saveTimer.current) clearTimeout(saveTimer.current);
              setTabs((prev) =>
                prev.map((t) =>
                  t.repo === repoPath && t.path === relPath ? { repo: repoPath, path: to } : t,
                ),
              );
              await openFile(repoPath, to);
            } else {
              setTabs((prev) =>
                prev.map((t) =>
                  t.repo === repoPath && t.path === relPath ? { repo: repoPath, path: to } : t,
                ),
              );
            }
          });
        },
      });
    },
    [fileAction, activeRepoPath, activePath, openFile],
  );

  /** New file in a given folder, rather than beside whatever is open. */
  const newFileIn = useCallback((repoPath: string, dir: string) => {
    setNaming({ repo: repoPath, dir });
  }, []);

  const deleteActive = async () => {
    if (!activeRepo || !activePath) return;
    if (!window.confirm(`Delete ${activePath} from disk?`)) return;
    try {
      await api.deletePlan(activeRepo.path, activePath);
      setActivePath(null);
      setContent("");
      setMatter(null);
      await refreshFiles();
      void refreshStatus();
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const onRun = useCallback(
    (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      fn()
        .then(() => notify(label))
        .catch((e) => notify(String(e), "error"))
        .finally(async () => {
          setBusy(null);
          setEpoch((n) => n + 1);
          await refreshStatus();
          await refreshFiles();
          if (activeRepoPath) {
            const info = await api.openRepo(activeRepoPath).catch(() => null);
            if (info)
              setRepos((prev) => prev.map((r) => (r.path === info.path ? info : r)));
          }
        });
    },
    [notify, refreshStatus, refreshFiles, activeRepoPath],
  );

  /**
   * Git, from the palette. These run through onRun, so the toast, the busy
   * state and the refresh afterwards match what the panel does.
   */
  const gitCommands = useMemo(() => {
    if (!activeRepo) return [];
    const repo = activeRepo.path;
    const entries = status?.entries ?? [];
    const staged = entries.filter((e) => e.index !== " " && e.index !== "?");
    const mine = entries.filter((e) => /\.(md|markdown)$/i.test(e.path));
    return [
      { id: "git.pull", label: "Pull", hint: "--ff-only", run: () => onRun("Pulled", () => api.gitPull(repo)) },
      { id: "git.push", label: "Push", run: () => onRun("Pushed", () => api.gitPush(repo)) },
      { id: "git.fetch", label: "Fetch", hint: "--prune", run: () => onRun("Fetched", () => api.gitFetch(repo)) },
      {
        id: "git.branch",
        label: "New branch…",
        run: () =>
          setAsking({
            title: "New branch",
            placeholder: "branch-name",
            note: `Branches from ${activeRepo.branch} and switches to it.`,
            confirm: "Create",
            run: (name: string) =>
              onRun(`On ${name}`, () => api.gitCreateBranch(repo, name)),
          }),
      },
      {
        id: "git.commit",
        label: "Commit staged…",
        hint: `${staged.length} staged`,
        run: () =>
          setAsking({
            title: "Commit",
            placeholder: "Describe this change",
            note: `${staged.length} file${staged.length === 1 ? "" : "s"} staged`,
            confirm: "Commit",
            multiline: true,
            run: (message: string) => onRun("Committed", () => api.gitCommit(repo, message)),
          }),
      },
      {
        id: "git.stage",
        label: "Stage every changed markdown file",
        run: () =>
          onRun("Staged", () =>
            api.gitStage(repo, mine.filter((e) => e.worktree !== " ").map((e) => e.path)),
          ),
      },
      {
        id: "git.unstage",
        label: "Unstage everything",
        run: () => onRun("Unstaged", () => api.gitUnstage(repo, staged.map((e) => e.path))),
      },
      ...branches
        .filter((b) => b !== activeRepo.branch)
        .map((b) => ({
          id: `git.switch.${b}`,
          label: `Switch to ${b}`,
          run: () => onRun(`On ${b}`, () => api.gitCheckout(repo, b)),
        })),
    ];
  }, [activeRepo, branches, status, onRun]);

  // --- keys ----------------------------------------------------------------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // While the palette is up it owns its own keys — don't also act on them.
      if (palette && !(e.metaKey || e.ctrlKey)) return;
      const mod = e.metaKey || e.ctrlKey;

      // ⌘⌃P is the profiler. Checked before the palette, which also answers to
      // "p" and would otherwise swallow it.
      if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPerf((v) => !v);
        return;
      }

      // ⌘P plans, ⌘⇧P commands, ⌘K either way. The ">" is what actually picks
      // the mode, so these are just two doors into the same box.
      if (mod && !e.ctrlKey && (e.key.toLowerCase() === "p" || e.key.toLowerCase() === "k")) {
        e.preventDefault();
        setPalette({ commands: e.shiftKey });
        return;
      }
      // ⌘+ / ⌘− resize whichever surface has focus: the tree if you're in it,
      // the page otherwise — so the default target is the thing you're reading.
      if (mod && ["=", "+", "-", "_"].includes(e.key)) {
        e.preventDefault();
        const inTree = !!(document.activeElement as HTMLElement | null)?.closest(".files");
        const up = e.key === "=" || e.key === "+";
        const key = inTree ? "treeSize" : "size";
        const r = RANGES[key];
        const next = settings[key] + (up ? r.step : -r.step);
        set({ [key]: Math.min(r.max, Math.max(r.min, next)) } as Partial<Settings>);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void addRepo();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newPlan();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "w") {
        // Closes the buffer, not the window — there is only ever one window.
        e.preventDefault();
        if (activeRepoPath && activePath) void closeTab(activeRepoPath, activePath);
      } else if (mod && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (tabs.length > 1) {
          const i = tabs.findIndex((t) => t.repo === activeRepoPath && t.path === activePath);
          const step = e.key === "ArrowRight" ? 1 : -1;
          const next = tabs[(i + step + tabs.length) % tabs.length];
          if (next) void openFile(next.repo, next.path);
        }
      } else if (mod && !e.shiftKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        goto(e.key === "1" ? "write" : e.key === "2" ? "source" : "diff");
      } else if (mod && e.key === "s") {
        e.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        void flush();
      } else if (mod && e.key.toLowerCase() === "b") {
        /**
         * ⌘B is the convention for the sidebar, but inside the page it has to
         * stay bold — so it goes to whichever is in front: the editor keeps it
         * while you are writing, the sidebar gets it everywhere else. ⌘⌃B
         * always toggles, for when the caret is in the page and you want it.
         */
        const inEditor = !!(document.activeElement as HTMLElement | null)?.closest(
          ".milkdown, .source, .diff-surface",
        );
        if (inEditor && !e.ctrlKey) return;
        e.preventDefault();
        set({ showIndex: !settings.showIndex });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setZen((z) => !z);
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        set({ showGit: !settings.showGit });
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setView((v) => (v === "diff" ? "write" : "diff"));
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setView((v) => (v === "settings" ? "write" : "settings"));
      } else if (e.key === "Escape" && zen) {
        setZen(false);
      } else if (e.key === "Escape" && view === "settings") {
        setView("write");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [
    flush,
    set,
    goto,
    closeTab,
    tabs,
    activeRepoPath,
    activePath,
    openFile,
    addRepo,
    newPlan,
    settings.showGit,
    settings.showIndex,
    settings.treeSize,
    settings.size,
    view,
    palette,
    zen,
  ]);

  const allFiles = useMemo(
    () =>
      repos.flatMap((r) =>
        (filesByRepo[r.path] ?? []).map((file) => ({
          repoPath: r.path,
          repoName: r.name,
          file,
        })),
      ),
    [repos, filesByRepo],
  );

  const activeKey = activeRepoPath && activePath ? `${activeRepoPath}::${activePath}` : null;

  const activeMark: Mark = activeKey
    ? dirty
      ? "mod"
      : (marks.get(activeKey) ?? "clean")
    : "clean";

  /** Marks, with the open file showing as edited the moment it's touched. */
  const liveMarks = useMemo(() => {
    if (!dirty || !activeKey) return marks;
    return new Map(marks).set(activeKey, "mod");
  }, [marks, dirty, activeKey]);

  // Zen keeps the page and nothing else — but Settings needs its chrome back.
  const zenOn = zen && view !== "settings";
  const gitOpen = settings.showGit && !!activeRepo && view !== "settings" && !zenOn;
  const treeOpen = settings.showIndex && !zenOn;

  return (
    <div
      className={`app ${settings.showStatusBar && !zenOn ? "" : "no-bar"} ${
        zenOn ? "zen" : ""
      }`}
    >
      {/* --- rail ---------------------------------------------------------- */}
      {/* WKWebView ignores -webkit-app-region, so dragging is opt-in per element. */}
      {/* In zen the rail stays — it clears the traffic lights and drags the
          window — but empties out to a bare strip with the way back. */}
      <header className="rail" data-tauri-drag-region>
        {zenOn ? (
          <>
            <span className="rail-spacer" data-tauri-drag-region />
            <button className="rail-btn" onClick={() => setZen(false)} title="Leave zen (esc)">
              Zen
            </button>
          </>
        ) : (
          <>
        <span className="wordmark" data-tauri-drag-region>
          Plans
        </span>
        <span className="rail-sep" data-tauri-drag-region />

        {repos.length > 0 ? (
          <>
            <Dropdown
              ariaLabel="Repository"
              value={activeRepoPath ?? ""}
              onChange={(v) => {
                if (v === "__add") void addRepo();
                else setActiveRepoPath(v);
              }}
              choices={[
                ...repos.map((r) => ({ value: r.path, label: r.name, note: r.branch })),
                { value: "__add", label: "Add a repository…", apart: true },
              ]}
            />
            {activeRepo && <span className="branch">{activeRepo.branch}</span>}
          </>
        ) : (
          <button className="rail-btn on" onClick={addRepo}>
            Add a repository
          </button>
        )}

        <span className="rail-spacer" data-tauri-drag-region />

        <button
          className={`rail-btn ${gitOpen ? "on" : ""}`}
          onClick={() => set({ showGit: !settings.showGit })}
          title="Git panel (⌘G)"
          aria-pressed={gitOpen}
        >
          Git
          {changeCount > 0 && <span className="count">{changeCount}</span>}
        </button>
        <button
          className={`rail-btn ${view === "settings" ? "on" : ""}`}
          onClick={() => setView((v) => (v === "settings" ? "write" : "settings"))}
          title="Settings (⌘,)"
          aria-pressed={view === "settings"}
        >
          <span className="aa">Aa</span>
        </button>
          </>
        )}
      </header>

      {/* --- body ---------------------------------------------------------- */}
      <div className={`body ${gitOpen ? "with-git" : ""} ${treeOpen ? "" : "no-files"}`}>
        {/* tabIndex so ⌘+ / ⌘− can tell the tree has focus. */}
        <section className="files" tabIndex={-1}>
          <input
            className="filter"
            placeholder="Search files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <div className="entries">
            <FileTree
              repos={repos}
              filesByRepo={filesByRepo}
              marks={liveMarks}
              activeRepoPath={view === "settings" ? null : activeRepoPath}
              activePath={activePath}
              expanded={expanded}
              onToggle={toggleNode}
              onOpen={openOne}
              onForgetRepo={forgetRepo}
              filter={filter}
              showExtensions={settings.showExtensions}
              onStage={stageOne}
              onUnstage={unstageOne}
              onDiscard={discardOne}
              onDelete={deleteOne}
              onNewFile={newFileIn}
              onRename={renameFile}
              onSetOpen={setOpen}
            />
          </div>

          {/* Double-click restores the default width. */}
          <div
            className="files-edge"
            onPointerDown={startResize}
            onDoubleClick={() => set({ treeWidth: DEFAULTS.treeWidth })}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the file tree"
          />
        </section>

        {/* --- page -------------------------------------------------------- */}
        <main className="page">
          {view === "settings" ? (
            <SettingsPage
              settings={settings}
              onChange={set}
              onReset={() => setSettings(DEFAULTS)}
              repos={repos}
              activeRepoPath={activeRepoPath}
              onAddRepo={addRepo}
              onForgetRepo={forgetRepo}
            />
          ) : (
            <>
              {/* Zen is one buffer and nothing else — no tabs, no header. */}
              {tabs.length > 0 && !zenOn && (
                <div className="tabs" role="tablist">
                  {tabs.map((t) => {
                    const on = t.repo === activeRepoPath && t.path === activePath;
                    const mark = liveMarks.get(`${t.repo}::${t.path}`) ?? "clean";
                    const name = t.path.split("/").pop() ?? t.path;
                    return (
                      <span className={`tab ${on ? "on" : ""} ${mark}`} key={`${t.repo}::${t.path}`}>
                        <button
                          className="tab-name"
                          role="tab"
                          aria-selected={on}
                          title={t.path}
                          onClick={() => void openFile(t.repo, t.path)}
                          onAuxClick={(e) => {
                            if (e.button === 1) void closeTab(t.repo, t.path);
                          }}
                        >
                          {displayName(name, settings.showExtensions)}
                        </button>
                        <button
                          className="tab-close"
                          aria-label={`Close ${name}`}
                          onClick={() => void closeTab(t.repo, t.path)}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              <div className={`page-head ${zenOn ? "hushed" : ""}`}>
                <span className="page-path">{activePath ?? ""}</span>
                {activePath && (
                  <span className="page-actions">
                    {/* Layout sits to the left of the view switch: appearing
                        between the switch and Delete moved them under the
                        pointer every time the diff was opened. */}
                    {view === "diff" && (
                      <span className="segmented small">
                        <button
                          className={settings.diffStyle === "unified" ? "on" : ""}
                          onClick={() => set({ diffStyle: "unified" })}
                        >
                          Unified
                        </button>
                        <button
                          className={settings.diffStyle === "split" ? "on" : ""}
                          onClick={() => set({ diffStyle: "split" })}
                        >
                          Split
                        </button>
                      </span>
                    )}

                    <span className="segmented small">
                      <button
                        className={view === "write" ? "on" : ""}
                        onClick={() => goto("write")}
                      >
                        Write
                      </button>
                      <button
                        className={view === "source" ? "on" : ""}
                        onClick={() => goto("source")}
                        title="The raw markdown, exactly as it is on disk"
                      >
                        Source
                      </button>
                      <button
                        className={view === "diff" ? "on" : ""}
                        onClick={() => goto("diff")}
                        title="Live diff against the last commit (⌘D)"
                      >
                        Diff
                      </button>
                    </span>
                    {/* Only where there is one to edit. */}
                    {matter !== null && (
                      <button
                        className={`rail-btn ${matterOpen ? "on" : ""}`}
                        onClick={() => setMatterOpen((o) => !o)}
                        title="Edit this file's YAML frontmatter"
                      >
                        Frontmatter
                      </button>
                    )}
                    <button className="rail-btn" onClick={deleteActive}>
                      Delete
                    </button>
                  </span>
                )}
              </div>

              {conflict && activePath && (
                <div className="conflict">
                  <p className="conflict-line">
                    This file changed on disk while you were editing it.
                  </p>
                  <p className="conflict-hint">
                    Nothing has been overwritten. Your version is still here, and
                    theirs is on disk — choose which one survives.
                  </p>
                  <span className="conflict-acts">
                    <button className="rail-btn" onClick={() => void resolveConflict("mine")}>
                      Keep mine
                    </button>
                    <button className="rail-btn" onClick={() => void resolveConflict("theirs")}>
                      Take theirs
                    </button>
                    <button
                      className="rail-btn"
                      onClick={() => goto("diff")}
                      title="Yours against the last commit"
                    >
                      See the diff
                    </button>
                  </span>
                </div>
              )}

              {!activePath ? (
                <div className="blank">
                  <p className="blank-line">
                    {activeRepo
                      ? "Choose a file from the tree, or start a new one."
                      : "Point the app at a repository and it will show you the markdown inside it."}
                  </p>
                  <dl className="blank-keys">
                    {(activeRepo
                      ? [
                          ["⌘P", "Find a file"],
                          ["⌘⇧P", "All commands"],
                          ["⌘N", "New file"],
                          ["⌘B", "Show or hide the tree"],
                          ["⌘G", "Git panel"],
                          ["⌘⇧L", "Zen"],
                          ["⌘,", "Settings"],
                        ]
                      : [
                          ["⌘⇧O", "Add a repository"],
                          ["⌘⇧P", "All commands"],
                          ["⌘,", "Settings"],
                        ]
                    ).map(([k, what]) => (
                      <div className="blank-key" key={k}>
                        <dt>{k}</dt>
                        <dd>{what}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : view === "source" || view === "write" ? (
                <>
                  {/*
                    Both surfaces stay mounted and the hidden one is put aside
                    with CSS. Unmounting the page meant rebuilding Milkdown on
                    every glance at the source, which is what made switching
                    feel slow; hiding costs a little memory and nothing else.
                  */}
                  <div className={`surface ${view === "write" ? "" : "aside"}`}>
                    <Editor
                      docKey={docKey}
                      repo={activeRepo?.path ?? ""}
                      relPath={activePath}
                      initialValue={content}
                      spellcheck={settings.spellcheck}
                      imageFolder={settings.imageFolder}
                      onChange={onChange}
                    />
                  </div>
                  <div className={`surface ${view === "source" ? "" : "aside"}`}>
                    <SourceView
                      value={source}
                      onChange={onSourceChange}
                      settings={settings}
                      docKey={docKey}
                      active={view === "source"}
                    />
                  </div>
                </>
              ) : (
                <div className="editor-host">
                  <DiffView
                    repo={activeRepo!.path}
                    relPath={activePath}
                    buffer={source}
                    onEdit={onSourceChange}
                    settings={settings}
                    epoch={epoch}
                  />
                </div>
              )}
            </>
          )}
        </main>

        {gitOpen && (
          <GitPanel
            repo={activeRepo!.path}
            status={status}
            busy={busy}
            onRun={onRun}
            notify={notify}
            onOpen={(p) => {
              void openFile(activeRepo!.path, p).then(() => setView("diff"));
            }}
          />
        )}
      </div>

      {/* --- bar ----------------------------------------------------------- */}
      {settings.showStatusBar && !zenOn && (
        <footer className="bar">
          {activePath && view !== "settings" ? (
            <>
              {/* The bar says it in words; the dot repeats it in colour. */}
              <span className={`bar-dot ${activeMark}`} aria-hidden />
              <span>{MARK_WORD[activeMark]}</span>
              {dirty ? (
                <span className="saving">saving</span>
              ) : savedAt ? (
                <span>
                  saved <b>{savedAt}</b>
                </span>
              ) : null}
            </>
          ) : (
            <span>{activeRepo?.name ?? "No repository"}</span>
          )}
          <span className="bar-spacer" />
          {busy && <span className="saving">{busy}…</span>}
          {changeCount > 0 && (
            <span>
              <b>{changeCount}</b> uncommitted
            </span>
          )}
          <span>⌘G git · ⌘D diff · ⌘, settings</span>
        </footer>
      )}

      {htmlEdit && (
        <TextPrompt
          title="HTML"
          multiline
          allowEmpty
          initial={htmlEdit.value}
          placeholder={'<div align="center">'}
          note="Written back as markdown, exactly as typed. Empty removes it."
          confirm="Apply"
          onCancel={() => setHtmlEdit(null)}
          onSubmit={(value) => {
            htmlBridge.apply?.({ ...htmlEdit, value });
            setHtmlEdit(null);
          }}
        />
      )}

      {asking && (
        <TextPrompt
          title={asking.title}
          placeholder={asking.placeholder}
          note={asking.note}
          confirm={asking.confirm}
          multiline={asking.multiline}
          initial={asking.initial}
          onCancel={() => setAsking(null)}
          onSubmit={(v) => {
            const run = asking.run;
            setAsking(null);
            run(v);
          }}
        />
      )}

      {naming && (
        <NameSheet
          dir={naming.dir}
          repo={naming.repo}
          repos={repos}
          // Folders belong to a repository, so choosing another starts at its root.
          onRepoChange={(repo) => setNaming({ repo, dir: "" })}
          dirs={folderChoices}
          onDirChange={(dir) => setNaming({ repo: naming.repo, dir })}
          onCancel={() => setNaming(null)}
          onCreate={(relPath, title) => void createFile(naming.repo, relPath, title)}
        />
      )}

      {matterOpen && (
        <FrontmatterSheet
          matter={matter}
          onChange={onMatterChange}
          onClose={() => setMatterOpen(false)}
        />
      )}

      <Palette
        open={!!palette}
        commandMode={!!palette?.commands}
        onClose={() => setPalette(null)}
        files={allFiles}
        activePath={activePath}
        activeRepoPath={activeRepoPath}
        repos={repos}
        settings={settings}
        set={set}
        onOpenFile={(r, p) => void openFile(r, p)}
        onSelectRepo={setActiveRepoPath}
        onAddRepo={() => void addRepo()}
        onNewPlan={newPlan}
        onSave={() => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          void flush();
        }}
        onView={goto}
        zen={zen}
        onZen={() => setZen((z) => !z)}
        canInsertHtml={view === "write" && !!activePath}
        canRename={!!activePath && !!activeRepoPath}
        onRename={() => activeRepoPath && activePath && renameFile(activeRepoPath, activePath)}
        onInsertHtml={() =>
          setAsking({
            title: "Insert HTML",
            placeholder: '<div align="center">',
            note: "Goes in at the cursor, one node per line, exactly as typed.",
            confirm: "Insert",
            multiline: true,
            run: (value) => htmlBridge.insert?.(value),
          })
        }
        onReload={() => void reloadAll()}
        searchRepo={activeRepoPath}
        onSearch={(query) =>
          activeRepoPath
            ? api.searchPlans(activeRepoPath, query, settings.showIgnored)
            : Promise.resolve([])
        }
        onOpenAt={(r, f) => void openFile(r, f)}
        onPerf={() => setPerf(true)}
        gitCommands={gitCommands}
        hasMatter={matter !== null}
        canEdit={!!activePath}
        onMatter={() => {
          if (matter === null) onMatterChange("");
          setMatterOpen(true);
        }}
      />

      {perf && <PerfHud onClose={() => setPerf(false)} />}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
