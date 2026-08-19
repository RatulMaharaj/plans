import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  type AgentFound,
  type CliStatus,
  type GitStatus,
  type PlanFile,
  type RepoInfo,
  type StatusEntry,
} from "./api";
import { Editor } from "./Editor";
import { GitPanel } from "./GitPanel";
import { ChatPanel } from "./ChatPanel";
import { agentCommandLine, HANDOFF_PROMPT } from "./agent";
import { DiffView } from "./DiffView";
import { SettingsPage } from "./SettingsPage";
import { installSkill, skillState, type SkillState } from "./skill";
import { Palette } from "./Palette";
import { Dropdown } from "./Dropdown";
import { FileTree, displayName, MARK_WORD, type Mark } from "./FileTree";
import { FrontmatterSheet } from "./Frontmatter";
import { NameSheet } from "./NameSheet";
import { MoveSheet } from "./MoveSheet";
import { TextPrompt } from "./TextPrompt";
import { SourceView } from "./SourceView";
import { UpdateBanner } from "./UpdateBanner";
import { RELEASE_SECTIONS, RELEASE_VERSION } from "./release-notes";
import { checkForUpdate, installUpdate, isNewer, runningVersion, type Available } from "./update";
import { PerfHud } from "./PerfHud";
import { start, tick, trace } from "./perf";
import { confirmed } from "./confirm";
import { authorSlug, htmlBridge, type HtmlEdit } from "./html-view";
import {
  inDoneFolder,
  isDone,
  joinFrontmatter,
  matterValue,
  setMatterValue,
  splitFrontmatter,
  statusTone,
} from "./matter";
import {
  applySettings,
  DEFAULTS,
  loadSettings,
  RANGES,
  saveSettings,
  type Settings,
} from "./settings";
import {
  resumeAnalytics,
  setRepoCount,
  setAppVersion as stampVersion,
  stopAnalytics,
  track,
} from "./analytics";
import "./App.css";

const KEY = {
  repos: "plans.repos.v1",
  last: "plans.last.v1",
  tabs: "plans.tabs.v1",
  dirs: "plans.dirs.v1",
};

/** How a buffer is being looked at. The settings page is not a view of a
 *  buffer, so it lives apart, as `settingsOpen`. */
type View = "write" | "source" | "diff";

/** An open buffer. The text lives on disk; this is only what is on the bar.
 *  `view` is the mode the buffer was left in; absent means write, which also
 *  covers every tab stored before modes were per-buffer. */
type Tab = { repo: string; path: string; view?: View };

/**
 * The repository a buffer has when it has no repository.
 *
 * Some things the app wants to show are documents but not files — the release
 * notes, so far. Rather than a sheet with its own renderer and its own escape
 * key, they open as an ordinary buffer whose text lives in memory. The
 * sentinel is not a path, so nothing that walks the disk can mistake it for
 * one, and it is not in `repos`, so `activeRepo` is null for these buffers and
 * every write path already refuses them without being told to.
 */
const MEMORY = "\u0000memory";

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
    // Either side may be missing: `refreshStatusFor` compares one repository's
    // new status against a `prev[repo]` that is undefined the first time it
    // runs, and "nothing" is never the same as "something".
    if (!x || !y) return false;
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


/**
 * A slider fires a change per step; one event per press is what's wanted. The
 * name of the setting is held for a beat and sent once things go quiet.
 */
const settleTimers = new Map<string, number>();
function noteSettingChange(key: string) {
  // Not settings in the sense a person would recognise — window furniture and
  // bookkeeping the app writes to itself.
  if (key === "treeWidth" || key === "lastSeenVersion") return;
  const had = settleTimers.get(key);
  if (had) clearTimeout(had);
  settleTimers.set(
    key,
    window.setTimeout(() => {
      settleTimers.delete(key);
      track("setting_changed", { setting: key });
    }, 1500),
  );
}

export default function App() {
  // Counts renders of the whole app, which is the cost a keystroke used to pay.
  tick("render App");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      /*
       * Beside the page there is only room for one right-hand column, so git
       * and the chat take turns: whichever was just asked for wins, and the
       * other closes rather than being refused. Enforced here because every
       * door — the rail, the palette, ⌘G/⌘J, Settings — comes through `set`,
       * and a rule written at one of them would be missing from the rest.
       */
      if (next.chatPlace === "side") {
        if (patch.showGit && next.showMux) next.showMux = false;
        if (patch.showMux && next.showGit) next.showGit = false;
        // Moving the chat to the side with both open: the chat is what moved.
        if (patch.chatPlace === "side" && next.showGit && next.showMux) next.showGit = false;
      }
      return next;
    });
    // Which knobs get turned, never what they were turned to — a font size is
    // harmless, but "imageFolder" is a path, so only the name goes.
    for (const key of Object.keys(patch)) noteSettingChange(key);
  }, []);

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
  /** null until asked, then the CLI's version string or false for "no agent". */
  const [chat, setChat] = useState<string | null | false>(null);
  /** A message the app wants the chat to send — "Hand off" arrives this way. */
  const [chatSeed, setChatSeed] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [palette, setPalette] = useState<null | { commands: boolean }>(null);
  /** So the open path can call itself once after refreshing a stale tree. */
  const openFileRef = useRef<
    ((repo: string, path: string, retrying?: boolean) => Promise<void>) | null
  >(null);

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
  /** The mode belongs to the buffer, so it is a derivation of the tab, not
   *  state of its own — which is also what makes it survive a restart. */
  const view: View =
    tabs.find((t) => t.repo === activeRepoPath && t.path === activePath)?.view ?? "write";
  const setBufferView = useCallback(
    (next: View) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.repo === activeRepoPath && t.path === activePath ? { ...t, view: next } : t,
        ),
      );
    },
    [activeRepoPath, activePath],
  );
  /**
   * Folders made here that hold no markdown yet.
   *
   * The tree is built from files, so a new folder would be invisible — and git
   * does not record an empty directory either, so nothing else remembers it.
   * They are dropped from this list as soon as they have a file of their own.
   */
  const [emptyDirs, setEmptyDirs] = useState<Record<string, string[]>>(() =>
    stored<Record<string, string[]>>(KEY.dirs, {}),
  );
  /** The same list, readable from inside the poll without re-arming it. */
  const emptyDirsRef = useRef(emptyDirs);
  emptyDirsRef.current = emptyDirs;
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
  /**
   * Set the first time the rail's branch picker is opened. The list is slow
   * enough to be worth not fetching for people who never change branch, and
   * the rail is on screen always — so the picker asks rather than the rail.
   */
  const [wantBranches, setWantBranches] = useState(false);
  /** Every folder in a repository, for the sheets that place a file. */
  const foldersIn = useCallback(
    (repo: string) => {
      const seen = new Set<string>(emptyDirs[repo] ?? []);
      for (const f of filesByRepo[repo] ?? []) {
        const parts = f.relPath.split("/");
        for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join("/"));
      }
      return [...seen].sort();
    },
    [filesByRepo, emptyDirs],
  );

  const folderChoices = useMemo(() => {
    if (!naming) return [];
    const seen = new Set<string>(emptyDirs[naming.repo] ?? []);
    for (const f of filesByRepo[naming.repo] ?? []) {
      const parts = f.relPath.split("/");
      for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join("/"));
    }
    return [...seen].sort();
  }, [naming, filesByRepo, emptyDirs]);

  /** A fragment of HTML open for editing, or null. */
  const [htmlEdit, setHtmlEdit] = useState<HtmlEdit | null>(null);
  /** Right-click on the page: one item, patterned on the tree's menu. */
  const [pageMenu, setPageMenu] = useState<null | { x: number; y: number }>(null);
  useEffect(() => {
    if (!pageMenu) return;
    const close = () => setPageMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPageMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [pageMenu]);
  /** A file being moved, which is a different question from being renamed. */
  const [moving, setMoving] = useState<null | { repo: string; path: string }>(null);
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

  // --- updates -------------------------------------------------------------
  const [update, setUpdate] = useState<Available | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  /** The version whose notes are on screen; null when the sheet is closed. */
  /** Text for the memory buffers, by path. Not persisted — that is the point. */
  const memoryDocs = useRef(new Map<string, string>());
  /** Opening the notes is defined below the buffer machinery it needs. */
  const openNotesRef = useRef<
    ((seen: string | null, running: string) => Promise<void>) | null
  >(null);
  /** What is actually running, which is not always what was bundled with. */
  const [appVersion, setAppVersion] = useState(RELEASE_VERSION);

  /**
   * Who git says the user is, per repository — the app's only identity. The
   * repo plus access to it has everything collaboration needs; sign-in is
   * `git config`, where it always was. Fetched once per repo and kept.
   */
  const [identityByRepo, setIdentityByRepo] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const r of repos) {
      if (identityByRepo[r.path] !== undefined) continue;
      void api.gitIdentity(r.path).then(
        (id) => setIdentityByRepo((m) => ({ ...m, [r.path]: authorSlug(id.name) })),
        () => setIdentityByRepo((m) => ({ ...m, [r.path]: "" })),
      );
    }
  }, [repos, identityByRepo]);

  const activeRepo = useMemo(
    () => repos.find((r) => r.path === activeRepoPath) ?? null,
    [repos, activeRepoPath],
  );

  /**
   * The repository a buffer belongs to, which is not always one in the list:
   * a file can be opened from a path that was never added — `plans <file>`,
   * or a repo forgotten while its tab stayed open. Views that only need the
   * path take this, so they keep working instead of dereferencing a `null`
   * `activeRepo` and taking the window down with them.
   */
  const activeRepoOrPath = activeRepo?.path ?? activeRepoPath ?? "";

  const status = activeRepoPath ? (statusByRepo[activeRepoPath] ?? null) : null;

  /** Whoever git says is here, as the `@name` a comment carries. */
  const author = activeRepoPath ? (identityByRepo[activeRepoPath] ?? "") : "";

  /**
   * Select some prose, comment on it. The comment goes in after the paragraph
   * the selection ends in — an aside under the thing it is about, the way a
   * person writes one — through `htmlBridge.comment`.
   */
  const newComment = useCallback(() => {
    const me = author;
    setAsking({
      title: "New comment",
      placeholder: "What needs saying?",
      note: me
        ? `Lands after the paragraph, as <!-- @${me}: … -->. ⌘⇧M from anywhere in the page.`
        : "Lands after the paragraph as an HTML comment. git config user.name would sign it.",
      confirm: "Comment",
      multiline: true,
      run: (value) => {
        const text = value.trim();
        if (!text) return;
        htmlBridge.comment?.(me ? `<!-- @${me}: ${text} -->` : `<!-- ${text} -->`);
      },
    });
  }, [author]);

  const notify = useCallback((text: string, kind: "info" | "error" = "info") => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), kind === "error" ? 6000 : 2200);
  }, []);

  /**
   * Each view change reports where the reader came from and how long they
   * stayed there, so "where is the time spent — write, source, diff?" is a
   * sum over `from`/`seconds` rather than a guess from event gaps.
   */
  const viewSince = useRef<{ view: View; at: number } | null>(null);
  useEffect(() => {
    const prev = viewSince.current;
    viewSince.current = { view, at: Date.now() };
    track("view_changed", {
      view,
      ...(prev && {
        from: prev.view,
        seconds: Math.round((Date.now() - prev.at) / 1000),
      }),
    });
  }, [view]);

  // Every event carries the repo count, so any behaviour can be split by it.
  useEffect(() => {
    setRepoCount(repos.length);
  }, [repos.length]);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  // The toggle takes effect on the press, not on the next launch: someone who
  // turns it off has usually just decided they want it off now.
  useEffect(() => {
    if (settings.telemetry) resumeAnalytics();
    else stopAnalytics();
  }, [settings.telemetry]);

  /**
   * Ask the feed. An automatic check that fails says nothing — offline, a
   * proxy, GitHub having a bad afternoon are none of the reader's problem to
   * solve. A check the reader asked for reports either way, including "you're
   * up to date", because silence there reads as a broken button.
   */
  const lookForUpdate = useCallback(
    async (asked: boolean) => {
      try {
        const found = await checkForUpdate();
        if (found) setUpdate(found);
        else if (asked) notify(`Plans ${await runningVersion()} is the latest version`);
      } catch (e) {
        if (asked) notify(String(e), "error");
      }
    },
    [notify],
  );

  // On launch, after a delay, and then on an interval for the sessions that
  // stay open for days — which is the normal way an editor gets used. Never on
  // the path to first paint.
  useEffect(() => {
    if (settings.updates === "off") return;
    const first = setTimeout(() => void lookForUpdate(false), 8_000);
    const every = setInterval(() => void lookForUpdate(false), 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [settings.updates, lookForUpdate]);

  /**
   * After an update, the notes open by themselves — once. A changelog that
   * interrupts twice is one people learn to dismiss unread, and then the one
   * release where it mattered goes unread too.
   *
   * The running binary is the authority on its own version; the bundled notes
   * only describe what they were built from.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      let running = RELEASE_VERSION;
      try {
        running = await runningVersion();
      } catch {
        // Not in a Tauri window (a browser test run): the bundled version is
        // the best answer available and nothing here is load-bearing.
      }
      if (!alive) return;
      setAppVersion(running);
      stampVersion(running);
      const seen = settings.lastSeenVersion;
      if (seen && !isNewer(running, seen)) return;
      // A fresh install shows nothing: there is nothing new about the version
      // you just chose to install. Remember it and wait for the next one.
      if (seen) void openNotesRef.current?.(seen, running);
      set({ lastSeenVersion: running });
    })();
    return () => {
      alive = false;
    };
    // Once, on boot — later changes to lastSeenVersion are this effect's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * On demand, from the palette: everything, not only what is unseen. Asking
   * for the notes is asking to read them, whether or not you have already.
   */
  const showNotes = useCallback(async () => {
    let running = RELEASE_VERSION;
    try {
      running = await runningVersion();
    } catch {
      /* the bundled version is the best answer available */
    }
    await openNotesRef.current?.(null, running);
  }, []);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    setProgress(0);
    try {
      await installUpdate(update, setProgress);
    } catch (e) {
      setInstalling(false);
      setProgress(null);
      notify(`Update failed: ${e}`, "error");
    }
  }, [update, notify]);

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
      // One clean sample per launch of how many repositories come back.
      track("repos_restored", { repos: ok.length });
      const last = stored<string | null>(KEY.last, null);
      const active = ok.find((r) => r.path === last)?.path ?? ok[0]?.path ?? null;
      setActiveRepoPath(active);
      // Open the repository being worked in, so the app starts with its files
      // in view rather than with a collapsed row and nothing to read.
      if (active) setExpanded((prev) => new Set(prev).add(`${active}::`));
    });
  }, []);

  // A repository named on the command line: `plans .` at launch hands its
  // path over once the frontend asks; a later `plans .` in another terminal
  // reaches the running instance as a forwarded event instead.
  const openRepoPath = useCallback(
    async (path: string) => {
      try {
        const info = await api.openRepo(path);
        setRepos((prev) =>
          prev.some((r) => r.path === info.path) ? prev : [...prev, info],
        );
        setActiveRepoPath(info.path);
        setExpanded((prev) => new Set(prev).add(`${info.path}::`));
        track("repo_opened_cli");
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [notify],
  );
  useEffect(() => {
    api
      .cliOpenPath()
      .then((p) => {
        if (p) openRepoPath(p);
      })
      .catch(() => {});
    const un = listen<string>("cli-open", (e) => openRepoPath(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, [openRepoPath]);

  useEffect(() => {
    localStorage.setItem(KEY.repos, JSON.stringify(repos.map((r) => r.path)));
  }, [repos]);

  useEffect(() => {
    // Memory buffers are not restored: their text lives only in this window,
    // so a tab pointing at one would come back empty and unopenable.
    localStorage.setItem(KEY.tabs, JSON.stringify(tabs.filter((t) => t.repo !== MEMORY)));
  }, [tabs]);

  useEffect(() => {
    localStorage.setItem(KEY.dirs, JSON.stringify(emptyDirs));
  }, [emptyDirs]);

  // Once a folder has markdown in it, the tree finds it on its own.
  useEffect(() => {
    setEmptyDirs((prev) => {
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [repo, dirs] of Object.entries(prev)) {
        const files = filesByRepo[repo];
        if (!files) {
          next[repo] = dirs;
          continue;
        }
        const kept = dirs.filter((d) => !files.some((f) => f.relPath.startsWith(`${d}/`)));
        if (kept.length !== dirs.length) changed = true;
        if (kept.length) next[repo] = kept;
      }
      return changed ? next : prev;
    });
  }, [filesByRepo]);

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
    /*
     * The remembered empty folders live only in localStorage — nothing on disk
     * records them — so a folder deleted outside the app, or swept away by a
     * git checkout, stayed in the tree forever. Ask the disk which are still
     * there, every time the files are re-read.
     */
    const still: Record<string, string[]> = {};
    for (const r of repos) {
      const dirs = emptyDirsRef.current[r.path] ?? [];
      if (!dirs.length) continue;
      try {
        still[r.path] = await api.existingDirs(r.path, dirs);
      } catch {
        still[r.path] = dirs; // an error is not evidence they are gone
      }
    }
    setEmptyDirs((prev) => {
      let changed = false;
      const next: Record<string, string[]> = { ...prev };
      for (const [repo, dirs] of Object.entries(still)) {
        const cur = prev[repo] ?? [];
        const kept = cur.filter((d) => dirs.includes(d));
        if (kept.length !== cur.length) {
          changed = true;
          if (kept.length) next[repo] = kept;
          else delete next[repo];
        }
      }
      return changed ? next : prev;
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

  /**
   * Whether the chat is on screen.
   *
   * `chat !== false` rather than `chat`: null means "not asked yet", and
   * hiding the panel for the first moments after launch would make it
   * flicker in.
   */
  const muxOpen =
    settings.showMux && chat !== false && !!activeRepoPath && !settingsOpen && !zen;

  /** Which of the two places the chat is in — the grid reads this, not the setting. */
  const chatSide = settings.chatPlace === "side";

  /**
   * Is there an agent to talk to at all? Asked when the binary setting
   * changes; `false` hides the feature rather than offering a chat that
   * fails when spoken to.
   */
  useEffect(() => {
    void api
      .agentList()
      .then((all) => {
        setAgents(all);
        // The chosen agent, or any that is installed: someone whose settings
        // name an agent they have since removed should still get a chat.
        const want = all.find((a) => a.id === settings.chatCommand && a.ready);
        const any = all.find((a) => a.ready);
        setChat((want ?? any)?.id ?? false);
      })
      .catch(() => setChat(false));
  }, [settings.chatCommand]);

  /**
   * The porcelain codes that mean "both sides are still in the file".
   * `U` on either side, or the two same-letter pairs git uses for add/add and
   * delete/delete — the cases where neither `index` nor `worktree` is `U`.
   */
  const conflicted = (e: StatusEntry) =>
    e.index === "U" || e.worktree === "U" || e.index + e.worktree === "AA" || e.index + e.worktree === "DD";

  /** "<repo>::<path>" -> mark, so the tree carries git state with the panel closed. */
  const marks = useMemo(() => {
    const m = new Map<string, Mark>();
    for (const [repo, st] of Object.entries(statusByRepo)) {
      for (const e of st.entries) {
        const k = `${repo}::${e.path}`;
        // Conflict first: git writes "UU", "AA", "DU" and friends, and none of
        // them mean staged — the file on disk still has both sides in it.
        if (conflicted(e)) m.set(k, "conflict");
        else if (e.index !== " " && e.index !== "?") m.set(k, "staged");
        else if (e.worktree === "?") m.set(k, "new");
        else if (e.worktree !== " ") m.set(k, "mod");
      }
    }
    return m;
  }, [statusByRepo]);

  /**
   * Start the agent on the open plan, as the first message of its chat.
   *
   * The prompt is the same instruction the tmux template carried; the
   * difference is where the run lives. Nothing is committed and nothing is
   * watched from here: the agent writes files and the poll notices.
   */
  const handOff = useCallback(
    async (repo?: string, path?: string) => {
      const r = repo ?? activeRepoPath;
      const f = path ?? activePath;
      if (!r || !f) return;
      // The chat is per-plan, so handing off a file that is not open has to
      // open it first — otherwise the seeded turn lands in another plan's
      // conversation.
      // Through the ref: `openFile` is declared further down, and this is the
      // same indirection the stale-tree retry already uses.
      if (r !== activeRepoPath || f !== activePath) await openFileRef.current?.(r, f);
      setChatSeed((settings.handoffPrompt || HANDOFF_PROMPT).replace(/\{file\}/g, f));
      set({ showMux: true });
    },
    [activeRepoPath, activePath, set, settings.handoffPrompt],
  );

  /**
   * Pressing a panel button from Settings.
   *
   * Both panels are hidden while Settings is open, so a plain toggle there
   * flips a setting nothing shows — the press appears to do nothing. Leaving
   * Settings and turning the panel *on* is what the press plainly meant.
   */
  const showPanel = useCallback(
    (key: "showGit" | "showMux") => {
      if (settingsOpen) {
        setSettingsOpen(false);
        set({ [key]: true } as Partial<Settings>);
        return;
      }
      set({ [key]: !settings[key] } as Partial<Settings>);
    },
    [settingsOpen, set, settings],
  );

  /** The same command, on the clipboard, for running it somewhere else. */
  const copyAgentCommand = useCallback(async () => {
    if (!activePath) return;
    const line = agentCommandLine(settings.agentCommand, activePath);
    await navigator.clipboard.writeText(line).then(
      () => notify(line),
      () => notify("Could not write to the clipboard", "error"),
    );
  }, [activePath, settings.agentCommand, notify]);

  const changeCount = status?.entries.length ?? 0;
  /** Git's answer once status has been read, the repo's own until then. */
  const branch = status?.branch ?? activeRepo?.branch ?? "";

  /**
   * Branches, on demand. Measured at over three seconds on a large repository,
   * which is not something to do on a timer for a list nobody has opened.
   */
  useEffect(() => {
    if (!activeRepoPath || (!palette && !settings.showGit && !wantBranches)) return;
    let live = true;
    api
      .gitBranches(activeRepoPath)
      .then((b) => live && setBranches(b.branches))
      .catch(() => live && setBranches([]));
    return () => {
      live = false;
    };
  }, [activeRepoPath, status?.branch, epoch, palette, settings.showGit, wantBranches]);

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
      // The count, not the name — how many repositories someone keeps open is
      // a product question; which ones they are is nobody's business.
      track("repo_added", { repos: repos.length + 1 });
    } catch (e) {
      notify(String(e), "error");
    }
  }, [notify, repos.length]);

  const forgetRepo = useCallback(
    (path: string) => {
      setRepos((prev) => prev.filter((r) => r.path !== path));
      track("repo_removed", { repos: Math.max(0, repos.length - 1) });
      setActiveRepoPath((cur) => (cur === path ? null : cur));
      if (activeRepoPath === path) {
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
    },
    [activeRepoPath, repos.length],
  );

  /**
   * What is already installed, so Settings can say so rather than offering the
   * same "Install" to someone who has pressed it. Both are read when Settings
   * opens and again after a press, because a button that does not change is a
   * button people press twice.
   */
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [agents, setAgents] = useState<AgentFound[]>([]);
  const [skills, setSkills] = useState<Record<string, SkillState>>({});

  const readInstalls = useCallback(async () => {
    api.cliStatus().then(setCli, () => setCli(null));
    api.agentList().then(setAgents, () => setAgents([]));
    for (const r of repos) {
      void skillState(r.path).then((st) =>
        setSkills((prev) => (prev[r.path] === st ? prev : { ...prev, [r.path]: st })),
      );
    }
  }, [repos]);

  useEffect(() => {
    if (settingsOpen) void readInstalls();
  }, [settingsOpen, readInstalls]);

  const installCli = useCallback(async () => {
    try {
      const dest = await api.installCli();
      notify(`Installed — try \`plans .\` (${dest})`, "info");
      track("cli_installed");
      void readInstalls();
    } catch (e) {
      notify(String(e), "error");
    }
  }, [notify, readInstalls]);

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

  /**
   * Dragging the chat's edge — its top when it is a row, its left when it is
   * a column. Both are the same gesture against a different axis, so one
   * handler measures the panel it was started on and works from that: the
   * size is the distance from the pointer to the edge that is not moving.
   */
  const startChatResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      const panel = el.parentElement;
      if (!panel) return;
      const fixed = panel.getBoundingClientRect();
      const side = settings.chatPlace === "side";
      const r = side ? RANGES.chatWidth : RANGES.muxHeight;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const px = Math.round(side ? fixed.right - ev.clientX : fixed.bottom - ev.clientY);
        const v = Math.min(r.max, Math.max(r.min, px));
        set(side ? { chatWidth: v } : { muxHeight: v });
      };
      const done = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", done);
        el.removeEventListener("pointercancel", done);
        document.body.classList.remove("resizing", "resizing-row");
      };
      document.body.classList.add("resizing");
      if (!side) document.body.classList.add("resizing-row");
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", done);
      el.addEventListener("pointercancel", done);
    },
    [set, settings.chatPlace],
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
      track("file_saved", { autosave: settings.autosave, chars: p.text.length });
      setSavedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
      // Only the repository that was written to. Re-reading every open repo's
      // status on each autosave is a lot of work for one file's worth of news.
      void refreshStatusFor(p.repo);
    } catch (e) {
      if (String(e).includes("STALE")) {
        /**
         * Unless the file is simply not there any more. Nothing can be
         * overwritten in that case, so refusing the write only strands the
         * text — the buffer is the last copy of it.
         */
        const now = await api.statPlan(p.repo, p.path).catch(() => null);
        if (now === "absent") {
          stamp.current = await api.writePlan(p.repo, p.path, p.text).catch(() => null);
          setDirty(false);
          void refreshFiles();
          return;
        }
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
  }, [notify, refreshStatus, settings.autosave]);

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
      if (next === "source" && view !== "source") sourceOnEntry.current = source;
      if (next === "write" && view === "source" && activePath) {
        const changed = sourceOnEntry.current !== null && sourceOnEntry.current !== source;
        if (changed) setDocKey(`${activeRepoPath}::${activePath}::${Date.now()}`);
        sourceOnEntry.current = null;
      }
      setBufferView(next);
    },
    [activePath, activeRepoPath, source, view, setBufferView],
  );

  /** Editing the metadata block saves on the same terms as editing the prose. */
  const onMatterChange = useCallback(
    (next: string | null) => {
      if (!activeRepo || !activePath) return;
      setMatter(next);
      setDirty(true);
      /*
       * Tell the tree straight away.
       *
       * A row's status comes from `list_plans`, which only runs on the slow
       * refresh — so marking a plan done left it sitting in the tree, still
       * showing its old badge, until a poll got round to it. Nothing needs to
       * be read back to know the answer: the value was just typed here.
       */
      const status = matterValue(next ?? "", "status") || null;
      setFilesByRepo((prev) => {
        const files = prev[activeRepo.path];
        if (!files) return prev;
        const i = files.findIndex((f) => f.relPath === activePath);
        if (i === -1 || files[i].status === status) return prev;
        const copy = files.slice();
        copy[i] = { ...copy[i], status };
        return { ...prev, [activeRepo.path]: copy };
      });
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

  /** The palette's status choices, from settings — a convention, not a schema. */
  const statusChoices = useMemo(
    () =>
      settings.statuses
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [settings.statuses],
  );

  /**
   * Write `status:` without opening the sheet. Setting it on a file with no
   * frontmatter creates the block; clearing the last key removes it — a block
   * holding nothing is noise the file never asked for.
   */
  const setStatus = useCallback(
    (value: string | null) => {
      const next = setMatterValue(matter ?? "", "status", value);
      onMatterChange(next.trim().length ? next : null);
    },
    [matter, onMatterChange],
  );

  /**
   * Scaffold the conventional keys in one stroke — the ones the header reads —
   * then open the sheet so the blanks can be filled. Existing keys keep their
   * values; this only adds what is missing.
   */
  const scaffoldMatter = useCallback(() => {
    let m = matter ?? "";
    if (!matterValue(m, "title") && activePath) {
      const name = activePath.split("/").pop() ?? activePath;
      m = setMatterValue(m, "title", displayName(name, false));
    }
    if (!matterValue(m, "status")) m = setMatterValue(m, "status", statusChoices[0] ?? "draft");
    if (!matterValue(m, "owner") && author) m = setMatterValue(m, "owner", author);
    if (!matterValue(m, "due")) m = setMatterValue(m, "due", "");
    onMatterChange(m);
    setMatterOpen(true);
  }, [matter, activePath, statusChoices, author, onMatterChange]);

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
    async (repoPath: string, relPath: string, retrying = false) => {
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
        trace("opened", { relPath, chars: text.length });
        setActiveRepoPath(repoPath);
        setActivePath(relPath);
        setMatter(split.matter);
        setContent(split.body);
        setDocKey(`${repoPath}::${relPath}::${Date.now()}`);
        // The entry snapshot belongs to the previous buffer; a fresh open
        // rebuilds the editor anyway, so a stale one must not linger.
        sourceOnEntry.current = null;
        setDirty(false);
        setSavedAt(null);
        setMatterOpen(false);
        setTabs((prev) =>
          prev.some((t) => t.repo === repoPath && t.path === relPath)
            ? prev
            : [...prev, { repo: repoPath, path: relPath }],
        );
        setSettingsOpen(false);
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
        /**
         * A path that no longer exists is usually a stale tree — something was
         * renamed or moved and the list has not caught up. Refresh and try
         * once more before saying it cannot be opened, since the alternative
         * is a file that is plainly there refusing to open.
         */
        const missing = /could not read|No such file/i.test(String(e));
        if (missing && !retrying) {
          await refreshFiles();
          return openFileRef.current?.(repoPath, relPath, true);
        }
        trace("open failed", { relPath, error: String(e) });
        notify(`Could not open ${relPath}: ${String(e).replace(/^Error:\s*/, "")}`, "error");
      }
    },
    [flush, notify, settings.showFrontmatter, refreshFiles],
  );

  /**
   * Watch the open file for writes from anywhere else.
   *
   * Clean buffer: take the new version, since there is nothing of yours to
   * lose. Dirty buffer: say so and let the reader choose — never silently.
   */
  useEffect(() => {
    // A memory buffer has nothing on disk to have changed under it.
    if (settings.watchSeconds <= 0 || !activeRepoPath || !activePath) return;
    if (activeRepoPath === MEMORY) return;
    const t = setInterval(async () => {
      if (busy || conflict || writing.current || pending.current) return;
      const at = await api.statPlan(activeRepoPath, activePath).catch(() => null);
      if (!at || at === stamp.current) return;
      /**
       * A file that is gone is not a file that changed.
       *
       * "absent" is a stamp like any other as far as the comparison goes, so
       * without this a renamed, moved or deleted file reads as an edit by
       * someone else: a clean buffer tries to reload a path that no longer
       * exists, and a dirty one raises a conflict against nothing. Both leave
       * the document unwritable, which is what "cannot edit after renaming"
       * turned out to be.
       */
      if (at === "absent") return;
      // The other half of the hand-vs-agent question: `file_saved` counts
      // edits made here, this counts edits that arrived from outside — in
      // this app, almost always the agent writing the plan.
      track("external_change", { conflict: dirty || !!pending.current });
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

  openFileRef.current = openFile;

  /**
   * Open text the app is holding as a buffer, as though it were a file.
   *
   * No disk, no stamp, no tab restored on the next launch: it is a document
   * for as long as this window is open, and closing the tab is the whole of
   * throwing it away.
   */
  const openMemory = useCallback(
    async (name: string, text: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flush();
      memoryDocs.current.set(name, text);
      stamp.current = null;
      setConflict(null);
      original.current = { matter: null, raw: "", eol: true };
      setActiveRepoPath(MEMORY);
      setActivePath(name);
      setMatter(null);
      setContent(text);
      setDocKey(`${MEMORY}::${name}::${text.length}`);
      sourceOnEntry.current = null;
      setDirty(false);
      setSavedAt(null);
      setMatterOpen(false);
      setSettingsOpen(false);
      setTabs((prev) =>
        prev.some((t) => t.repo === MEMORY && t.path === name)
          ? prev
          : [...prev, { repo: MEMORY, path: name }],
      );
    },
    [flush],
  );

  /**
   * Everything that changed between `seen` and the running version.
   *
   * Skipping two releases should not mean skipping their notes, so this is a
   * range rather than a single section. Written as a plain markdown document,
   * because that is what the editor already knows how to render well.
   */
  const openNotes = useCallback(
    async (seen: string | null, running: string) => {
      // Everything newer than what you last read. No upper bound: the notes
      // are bundled with the build, so nothing here can be newer than what is
      // running, and a filter for that only misfires on odd version strings.
      const fresh = seen ? RELEASE_SECTIONS.filter((x) => isNewer(x.version, seen)) : [];
      const shown = fresh.length ? fresh : RELEASE_SECTIONS;
      const title = fresh.length && seen ? `# What changed since ${seen}` : `# Plans ${running}`;
      const body = shown
        .map((s) => `## ${s.version}\n\n${s.notes}`)
        .join("\n\n");
      await openMemory(
        "Release notes.md",
        `${title}\n\n${body || "No notes for this version."}\n`,
      );
    },
    [openMemory],
  );
  openNotesRef.current = openNotes;

  /** Close a buffer and step to whichever tab was next to it. */
  const closeTab = useCallback(
    async (repo: string, path: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flush();
      const i = tabs.findIndex((t) => t.repo === repo && t.path === path);
      const rest = tabs.filter((t) => !(t.repo === repo && t.path === path));
      setTabs(rest);
      // Closing a memory buffer is how you throw it away; there is nowhere
      // else its text exists.
      if (repo === MEMORY) memoryDocs.current.delete(path);
      if (repo !== activeRepoPath || path !== activePath) return;
      const next = rest[Math.min(i, rest.length - 1)];
      setConflict(null);
      setMatterOpen(false);
      if (next) {
        await (next.repo === MEMORY
          ? openMemory(next.path, memoryDocs.current.get(next.path) ?? "")
          : openFile(next.repo, next.path));
      } else {
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
    },
    [tabs, flush, activeRepoPath, activePath, openFile, openMemory],
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
      if (!(await confirmed(ask, { ok: gone ? "Delete" : "Discard" }))) return;
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
      if (!(await confirmed(`Delete ${relPath} from disk?`, { ok: "Delete" }))) return;
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

  /**
   * Delete a folder and everything under it. The tree only shows markdown, so
   * the folder may hold files the user has never seen — the census counts
   * them, and the question says so before anything is removed.
   */
  const deleteDir = useCallback(
    async (repoPath: string, relPath: string) => {
      let census: { files: number; hidden: number };
      try {
        census = await api.folderCensus(repoPath, relPath);
      } catch (e) {
        notify(String(e), "error");
        return;
      }
      if (census.files > 0) {
        const files = `${census.files} file${census.files === 1 ? "" : "s"}`;
        const unseen =
          census.hidden > 0
            ? ` ${census.hidden === census.files ? (census.files === 1 ? "It is" : "All of them are") : `${census.hidden} of them are`} not markdown, so the sidebar does not show ${census.hidden === 1 ? "it" : "them"}.`
            : "";
        if (!(await confirmed(`Delete ${relPath} and the ${files} inside it?${unseen}`, { ok: "Delete" }))) {
          return;
        }
      }
      const under = (path: string) => path === relPath || path.startsWith(`${relPath}/`);
      if (repoPath === activeRepoPath && activePath && under(activePath)) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pending.current = null;
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
      setTabs((prev) => prev.filter((t) => !(t.repo === repoPath && under(t.path))));
      setEmptyDirs((prev) => ({
        ...prev,
        [repoPath]: (prev[repoPath] ?? []).filter((d) => !under(d)),
      }));
      fileAction(repoPath, "Folder deleted", () => api.deleteFolder(repoPath, relPath));
    },
    [activeRepoPath, activePath, fileAction, notify],
  );

  const revealOne = useCallback(
    (r: string, f: string) =>
      void api.revealInFinder(r, f).catch((e) => notify(String(e), "error")),
    [notify],
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
  const deleteDirOne = useCallback((r: string, f: string) => void deleteDir(r, f), [deleteDir]);
  const openOne = useCallback((r: string, f: string) => void openFile(r, f), [openFile]);

  /**
   * Rename, which is also how a file moves: the answer is a path, so typing a
   * folder into it puts the file there. Git follows a rename on its own.
   */
  const renameFile = useCallback(
    (repoPath: string, relPath: string) => {
      const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
      const name = relPath.split("/").pop() ?? relPath;
      setAsking({
        title: "Rename",
        placeholder: name,
        initial: name,
        note: dir ? `In ${dir}` : "At the repository root",
        confirm: "Rename",
        run: (next) => {
          // A name, not a path: moving is its own question, with its own sheet.
          const bare = next.replace(/\//g, "-").trim();
          if (!bare) return;
          const named =
            bare.endsWith(".md") || bare.endsWith(".markdown") ? bare : `${bare}.md`;
          const to = dir ? `${dir}/${named}` : named;
          if (to === relPath) return;
          fileAction(repoPath, "Renamed", async () => {
            await api.renamePlan(repoPath, relPath, to);
            // Before anything tries to open the new path.
            await refreshFiles();
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

  /**
   * Move a file or a folder into another folder, by dragging it there.
   *
   * A move is a rename, which is what git wants to see: the history follows the
   * file rather than recording a deletion and an unrelated addition. Anything
   * open that lived under a moved folder follows it too, tabs included.
   */
  const moveTo = useCallback(
    (repoPath: string, from: string, dir: string) => {
      const name = from.split("/").pop() ?? from;
      const to = dir ? `${dir}/${name}` : name;
      if (to === from) return;

      fileAction(repoPath, "Moved", async () => {
        await api.renamePlan(repoPath, from, to);
        await refreshFiles();

        // Paths under a moved folder move with it.
        const rewrite = (path: string) =>
          path === from
            ? to
            : path.startsWith(`${from}/`)
              ? `${to}${path.slice(from.length)}`
              : path;

        setTabs((prev) =>
          prev.map((t) =>
            t.repo === repoPath ? { repo: t.repo, path: rewrite(t.path) } : t,
          ),
        );
        setEmptyDirs((prev) => ({
          ...prev,
          [repoPath]: (prev[repoPath] ?? []).map(rewrite),
        }));

        if (repoPath === activeRepoPath && activePath) {
          const next = rewrite(activePath);
          if (next !== activePath) {
            pending.current = null;
            if (saveTimer.current) clearTimeout(saveTimer.current);
            await openFile(repoPath, next);
          }
        }
      });
    },
    [fileAction, refreshFiles, activeRepoPath, activePath, openFile],
  );

  /** A folder, which the tree then remembers until it has files of its own. */
  const newFolderIn = useCallback(
    (repoPath: string, dir: string) => {
      setAsking({
        title: "New folder",
        placeholder: "notes",
        note: dir ? `Inside ${dir}` : "At the repository root",
        confirm: "Create",
        run: (name) => {
          const clean = name.trim().replace(/^\/+|\/+$/g, "");
          if (!clean) return;
          const path = dir ? `${dir}/${clean}` : clean;
          fileAction(repoPath, "Folder created", async () => {
            await api.createFolder(repoPath, path);
            setEmptyDirs((prev) => ({
              ...prev,
              [repoPath]: [...new Set([...(prev[repoPath] ?? []), path])],
            }));
            // Open it, and everything above it, so it is where you left it.
            setExpanded((prev) => {
              const next = new Set(prev).add(`${repoPath}::`);
              const parts = path.split("/");
              for (let i = 1; i <= parts.length; i++) {
                next.add(`${repoPath}::${parts.slice(0, i).join("/")}`);
              }
              return next;
            });
          });
        },
      });
    },
    [fileAction],
  );

  /** New file in a given folder, rather than beside whatever is open. */
  const newFileIn = useCallback((repoPath: string, dir: string) => {
    setNaming({ repo: repoPath, dir });
  }, []);


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
  // Whether keystrokes go to the document or to the app, held as state rather
  // than probed from activeElement on every keydown. focusin/focusout bubble
  // from every editable surface; on focusout the target that matters is where
  // focus went, which is relatedTarget (null when focus leaves entirely).
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const inSurface = (el: EventTarget | null) =>
      el instanceof Element && !!el.closest(".milkdown, .source, .diff-surface");
    const focusIn = (e: FocusEvent) => setEditing(inSurface(e.target));
    const focusOut = (e: FocusEvent) => setEditing(inSurface(e.relatedTarget));
    window.addEventListener("focusin", focusIn);
    window.addEventListener("focusout", focusOut);
    return () => {
      window.removeEventListener("focusin", focusIn);
      window.removeEventListener("focusout", focusOut);
    };
  }, []);

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
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "m") {
        // The convention every app that comments uses.
        e.preventDefault();
        if (view === "write" && activePath) newComment();
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
        if (editing && !e.ctrlKey) return;
        e.preventDefault();
        set({ showIndex: !settings.showIndex });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setZen((z) => !z);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        showPanel("showMux");
      } else if (mod && (e.key === "Backspace" || e.key === "Delete")) {
        /*
         * The Finder gesture, and it belongs to the tree.
         *
         * Anywhere else this chord already means something — in the page it
         * deletes to the start of the line — and "delete the file I happen to
         * have open" is too easy to fire by accident from a surface that has
         * nothing to do with files. The tree is where you point at a file, so
         * the tree is where deleting one is unambiguous.
         */
        const el = document.activeElement as HTMLElement | null;
        const row = el?.closest(".files")?.querySelector(".row.file.active");
        if (!el?.closest(".files") || !row) return;
        e.preventDefault();
        if (activeRepoPath && activePath && activeRepoPath !== MEMORY) {
          void deleteFile(activeRepoPath, activePath);
        }
      } else if (e.key === "F2") {
        // No modifier by convention, and no `editing` guard needed: F2 does
        // nothing in a text field.
        e.preventDefault();
        if (activeRepoPath && activePath && activeRepoPath !== MEMORY) {
          renameFile(activeRepoPath, activePath);
        }
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        showPanel("showGit");
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        goto(view === "diff" ? "write" : "diff");
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if (e.key === "Escape" && editing) {
        // Hand focus back to the app. In zen there is no tab row, so this
        // blurs only — a second Esc then leaves zen via the branch below.
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        document.querySelector<HTMLElement>(".tab.on .tab-name")?.focus();
      } else if (e.key === "Escape" && zen) {
        setZen(false);
      } else if (e.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
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
    newComment,
    showPanel,
    deleteFile,
    renameFile,
    settings.showIndex,
    settings.treeSize,
    settings.size,
    view,
    palette,
    zen,
    editing,
    settingsOpen,
  ]);

  /**
   * The tree's files, with finished plans dropped when the setting says so.
   *
   * Filtered here rather than in `filesByRepo` so the hiding is exactly what
   * it says: a view of the tree. Git marks, the watcher and everything else
   * keep seeing every file, and an open tab for a finished plan does not
   * close itself because you turned a setting off.
   */
  const shownByRepo = useMemo(() => {
    if (settings.showCompleted) return filesByRepo;
    const out: Record<string, PlanFile[]> = {};
    for (const [repo, files] of Object.entries(filesByRepo)) {
      out[repo] = files.filter((f) => !isDone(f.status) && !inDoneFolder(f.relPath));
    }
    return out;
  }, [filesByRepo, settings.showCompleted]);

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
  const zenOn = zen && !settingsOpen;
  const gitOpen = settings.showGit && !!activeRepo && !settingsOpen && !zenOn;
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
            {activeRepo && (
              <Dropdown
                className="branch-pick"
                ariaLabel="Branch"
                onOpen={() => setWantBranches(true)}
                value={branch}
                disabled={!!busy}
                onChange={(b) =>
                  onRun(`Switched to ${b}`, () => api.gitCheckout(activeRepo.path, b))
                }
                choices={(branches.length ? branches : [branch]).map((b) => ({
                  value: b,
                  label: b,
                }))}
              />
            )}
          </>
        ) : (
          <button className="rail-btn on" onClick={addRepo}>
            Add a repository
          </button>
        )}

        <span className="rail-spacer" data-tauri-drag-region />

        {/*
         * The mode still belongs to the buffer — `goto` sets it on the active
         * tab, not on the app — but it is read as chrome, so it sits in the
         * chrome. In the tab row it moved with the tabs and shared a line
         * with the buffer names, which made a per-buffer setting look like
         * part of the buffer list.
         */}
        {/* A memory buffer has no file to show the source of and no commit to
            diff against, so it is Write or nothing. */}
        {activePath && !settingsOpen && activeRepoPath !== MEMORY && (
          <span className="segmented small view-switch">
            <button className={view === "write" ? "on" : ""} onClick={() => goto("write")}>
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
        )}

        <button
          className={`rail-btn ${gitOpen ? "on" : ""}`}
          onClick={() => showPanel("showGit")}
          title="Git panel (⌘G)"
          aria-pressed={gitOpen}
        >
          Git
          {changeCount > 0 && <span className="count">{changeCount}</span>}
        </button>
        {chat !== false && (
          <button
            className={`rail-btn ${muxOpen ? "on" : ""}`}
            onClick={() => showPanel("showMux")}
            title="Agent chat (⌘J)"
            aria-pressed={muxOpen}
          >
            Chat
          </button>
        )}
        <button
          className={`rail-btn ${settingsOpen ? "on" : ""}`}
          onClick={() => setSettingsOpen((o) => !o)}
          title="Settings (⌘,)"
          aria-pressed={settingsOpen}
        >
          <span className="aa">Aa</span>
        </button>
          </>
        )}
      </header>

      {/* --- body ---------------------------------------------------------- */}
      <div
        className={`body ${gitOpen ? "with-git" : ""} ${treeOpen ? "" : "no-files"} ${
          muxOpen ? (chatSide ? "with-chat-side" : "with-mux") : ""
        }`}
        style={
          muxOpen
            ? ({
                [chatSide ? "--chat-w" : "--mux-h"]: `${
                  chatSide ? settings.chatWidth : settings.muxHeight
                }px`,
              } as React.CSSProperties)
            : undefined
        }
      >
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
              filesByRepo={shownByRepo}
              marks={liveMarks}
              activeRepoPath={settingsOpen ? null : activeRepoPath}
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
              onDeleteDir={deleteDirOne}
              onReveal={revealOne}
              onHandOff={chat === false ? undefined : (repo, path) => void handOff(repo, path)}
              onNewFile={newFileIn}
              onNewFolder={newFolderIn}
              onMove={moveTo}
              emptyDirs={emptyDirs}
              onRename={renameFile}
              onMoveTo={(repo, path) => setMoving({ repo, path })}
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
          {settingsOpen ? (
            <SettingsPage
              settings={settings}
              onChange={set}
              onReset={() => setSettings(DEFAULTS)}
              repos={repos}
              activeRepoPath={activeRepoPath}
              onAddRepo={addRepo}
              onForgetRepo={forgetRepo}
              onInstallSkill={(path) =>
                void installSkill(path).then(
                  (r) =>
                    notify(
                      r === "current"
                        ? "Agent skill already up to date"
                        : r === "installed"
                          ? "Agent skill installed"
                          : "Agent skill updated — review it in the git panel",
                    ),
                  (e) => notify(String(e), "error"),
                ).finally(() => void readInstalls())
              }
              skills={skills}
              onInstallCli={installCli}
              cli={cli}
              agents={agents}
              version={appVersion}
              onCheckUpdates={() => void lookForUpdate(true)}
              onReleaseNotes={() => void showNotes()}
              agent={chat}
            />
          ) : (
            <>
              {/* Zen is one buffer and nothing else — no tabs, no header. */}
              {tabs.length > 0 && !zenOn && (
                <div className="tab-row">
                <div className="tabs" role="tablist">
                  {tabs.map((t) => {
                    const on = t.repo === activeRepoPath && t.path === activePath;
                    const mark = liveMarks.get(`${t.repo}::${t.path}`) ?? "clean";
                    const name = t.path.split("/").pop() ?? t.path;
                    return (
                      <span
                        className={`tab ${on ? "on" : ""}${on && editing ? " editing" : ""} ${mark}`}
                        key={`${t.repo}::${t.path}`}
                      >
                        <button
                          className="tab-name"
                          role="tab"
                          aria-selected={on}
                          title={t.path}
                          onClick={() =>
                            void (t.repo === MEMORY
                              ? openMemory(t.path, memoryDocs.current.get(t.path) ?? "")
                              : openFile(t.repo, t.path))
                          }
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

                    {/* Read from a few conventional frontmatter keys and shown
                        read-only; the sheet stays the only writer. */}
                    {matter !== null &&
                      (() => {
                        const s = matterValue(matter, "status");
                        const who =
                          matterValue(matter, "owner") ?? matterValue(matter, "assignee");
                        const due = matterValue(matter, "due");
                        const overdue =
                          !!due && !Number.isNaN(Date.parse(due)) && Date.parse(due) < Date.now();
                        return (
                          <>
                            {s && (
                              <span
                                className={`status-badge tone-${statusTone(s)}`}
                                title="status: from this file's frontmatter"
                              >
                                {s}
                              </span>
                            )}
                            {who && (
                              <span
                                className="matter-owner"
                                title="owner: from this file's frontmatter"
                              >
                                @{who}
                              </span>
                            )}
                            {due && (
                              <span
                                className={`matter-due ${overdue ? "overdue" : ""}`}
                                title="due: from this file's frontmatter"
                              >
                                due {due}
                              </span>
                            )}
                          </>
                        );
                      })()}
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
                  <div
                    className={`surface ${view === "write" ? "" : "aside"}`}
                    onContextMenu={(e) => {
                      if (view !== "write") return;
                      e.preventDefault();
                      setPageMenu({ x: e.clientX, y: e.clientY });
                    }}
                  >
                    <Editor
                      docKey={docKey}
                      repo={activeRepo?.path ?? ""}
                      relPath={activePath}
                      initialValue={content}
                      spellcheck={settings.spellcheck}
                      imageFolder={settings.imageFolder}
                      author={author}
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
                    repo={activeRepoOrPath}
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
            repo={activeRepoOrPath}
            status={status}
            busy={busy}
            onRun={onRun}
            notify={notify}
            onOpen={(p) => {
              // Set the mode on that tab, not on whichever buffer was active
              // when the click happened.
              const repo = activeRepoOrPath;
              void openFile(repo, p).then(() =>
                setTabs((prev) =>
                  prev.map((t) =>
                    t.repo === repo && t.path === p ? { ...t, view: "diff" } : t,
                  ),
                ),
              );
            }}
          />
        )}

        {muxOpen && (
          <ChatPanel
            repo={activeRepoPath!}
            relPath={activePath}
            seed={chatSeed}
            onSeedUsed={() => setChatSeed(null)}
            cmd={settings.chatCommand}
            notify={notify}
            onResize={startChatResize}
          />
        )}
      </div>

      {/* --- bar ----------------------------------------------------------- */}
      {settings.showStatusBar && !zenOn && (
        <footer className="bar">
          {activePath && !settingsOpen ? (
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

      {pageMenu && (
        <div
          className="ctx"
          style={{ left: pageMenu.x, top: pageMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* One item, until something else earns a place on it. */}
          <button
            className="ctx-item"
            onClick={() => {
              setPageMenu(null);
              newComment();
            }}
          >
            New comment…
          </button>
        </div>
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

      {moving && (
        <MoveSheet
          relPath={moving.path}
          folders={foldersIn(moving.repo)}
          onCancel={() => setMoving(null)}
          onMove={(dir) => {
            const at = moving;
            setMoving(null);
            moveTo(at.repo, at.path, dir);
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
        onView={(v) => (v === "settings" ? setSettingsOpen(true) : goto(v))}
        zen={zen}
        onZen={() => setZen((z) => !z)}
        canInsertHtml={view === "write" && !!activePath}
        canNewFolder={!!activeRepoPath}
        onNewFolder={() =>
          activeRepoPath &&
          newFolderIn(
            activeRepoPath,
            activePath?.includes("/") ? activePath.slice(0, activePath.lastIndexOf("/")) : "",
          )
        }
        canRename={!!activePath && !!activeRepoPath}
        onRename={() => activeRepoPath && activePath && renameFile(activeRepoPath, activePath)}
        onMoveFile={() =>
          activeRepoPath && activePath && setMoving({ repo: activeRepoPath, path: activePath })
        }
        onNewComment={newComment}
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
        onCheckUpdates={() => void lookForUpdate(true)}
        onReleaseNotes={() => void showNotes()}
        gitCommands={gitCommands}
        hasMatter={matter !== null}
        canEdit={!!activePath}
        canHandOff={!!activePath && chat !== false}
        onHandOff={() => void handOff()}
        onCopyAgentCommand={() => void copyAgentCommand()}
        onMatter={() => {
          if (matter === null) onMatterChange("");
          setMatterOpen(true);
        }}
        statuses={statusChoices}
        currentStatus={matter !== null ? matterValue(matter, "status") : null}
        onSetStatus={setStatus}
        onScaffoldMatter={scaffoldMatter}
      />

      {perf && <PerfHud onClose={() => setPerf(false)} />}

      {/* The toast is transient and the banner is not, so they never share the
          spot above the status bar. */}
      {update && !toast && (
        <UpdateBanner
          found={update}
          progress={progress}
          installing={installing}
          onInstall={() => void install()}
          onDismiss={() => setUpdate(null)}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
