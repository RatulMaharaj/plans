import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  type AgentFound,
  type CliStatus,
  type ConfigOption,
  type GitStatus,
  type PlanFile,
  type RepoInfo,
  type StatusEntry,
} from "./api";
import { Editor } from "./Editor";
import { GitPanel } from "./GitPanel";
import { ChatPanel } from "./ChatPanel";
import {
  loadIndex as loadChats,
  saveIndex as saveChats,
  peekIndex as peekChats,
  sizeOf as chatSize,
  started as startedChat,
  without as chatWithout,
  type Index as ChatIndex,
} from "./chats";
import {
  agentCommandLine,
  HANDOFF_PROMPT,
  IMPLEMENT_PROMPT,
  lineHint,
  quoteBlock,
  REWRITE_PROMPT,
  type HandoffKind,
} from "./agent";
import { DiffView, prefetchHead } from "./DiffView";
import { SettingsPage } from "./SettingsPage";
import {
  installConventions,
  skillFileFor,
  skillState,
  SKILLS,
  type SkillState,
} from "./skill";
import { CHORD_MS, matchChordPrefix, matchKeys, mergeKeys, renderKeys } from "./keys";
import { KeyboardPage } from "./KeyboardPage";
import { ShortcutSheet } from "./ShortcutSheet";
import { SplitPane } from "./SplitPane";
import { Palette } from "./Palette";
import { Dropdown } from "./Dropdown";
import { FileTree, displayName, MARK_WORD, type Mark } from "./FileTree";
import { FrontmatterSheet } from "./Frontmatter";
import { NameSheet } from "./NameSheet";
import {
  bundledTemplates,
  loadTemplates,
  renderContent,
  renderName,
  slugOf,
  type Template,
  BUNDLED,
} from "./templates";
import {
  colorFor,
  configured as workspacesConfigured,
  openRoom,
  token as workspaceToken,
  workspace,
  type Account,
  type Room,
  type Workspace,
} from "./workspace";
import { Workspaces, reviewLabel, reviewTone } from "./Workspaces";
import { ShareSheet } from "./ShareSheet";
import { SignInSheet } from "./SignInSheet";
import { MoveSheet } from "./MoveSheet";
import { TextPrompt } from "./TextPrompt";
import { SourceView } from "./SourceView";
import { FindBar } from "./FindBar";
import { nearestMatchIndex, type FindHandle } from "./find";
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
  isMarkdownPath,
  joinFrontmatter,
  matterValue,
  setMatterValue,
  splitFrontmatter,
  statusTone,
} from "./matter";
import {
  applySettings,
  DEFAULTS,
  type Extras,
  loadSettings,
  parseSettingsFile,
  RANGES,
  saveSettings,
  serializeSettings,
  type Settings,
} from "./settings";
import SETTINGS_SCHEMA from "./settings.schema.json";
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
  split: "plans.split.v1",
  splitTabs: "plans.splitTabs.v1",
  splitDir: "plans.splitDir.v1",
  splitRatio: "plans.splitRatio.v1",
  repoNames: "plans.repoNames.v1",
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

/**
 * A workspace document rides the memory rails.
 *
 * Its repository is `MEMORY`, so every write path already refuses it, no tab
 * for it is restored on launch, and closing it is closing it; what marks it
 * as a workspace rather than the release notes is the path, which carries
 * the workspace's id behind a prefix nothing on disk can have. The text the
 * editor shows comes from the room, not from `memoryDocs`.
 */
const WS_PREFIX = "\u0000ws/";
const wsIdOf = (path: string | null | undefined) =>
  path && path.startsWith(WS_PREFIX) ? path.slice(WS_PREFIX.length) : null;

/**
 * How often the settings file is checked for an outside edit.
 *
 * Fixed, and deliberately separate from `watchSeconds`: that knob is about how
 * hard the app leans on the repository, while this is one `stat` of one path
 * that also happens to be the only way `watchSeconds` itself can be turned back
 * on from outside the app.
 */
const SETTINGS_POLL_MS = 2000;

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
  /**
   * What the sidebar calls each repository, when the folder's own name is not
   * the right one — a worktree's directory, or the third repo named `mono`.
   * An overlay rather than an edit to `repos`: the backend refreshes those
   * wholesale, and a name written into them would last until the next poll.
   */
  const [repoNames, setRepoNames] = useState<Record<string, string>>(() =>
    stored(KEY.repoNames, {}),
  );
  /** The repositories as the UI shows them — the alias, where one is set. */
  const shownRepos = useMemo(
    () =>
      repos.map((r) => (repoNames[r.path] ? { ...r, name: repoNames[r.path] } : r)),
    [repos, repoNames],
  );
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
  /** The Keyboard page, which lives beside Settings and shows in its place. */
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [palette, setPalette] = useState<null | { commands: boolean }>(null);
  /** So the open path can call itself once after refreshing a stale tree. */
  const openFileRef = useRef<
    ((repo: string, path: string, retrying?: boolean) => Promise<void>) | null
  >(null);
  /**
   * Which buffer is active *now*, readable from inside an awaited callback —
   * a closure's `activeRepoPath`/`activePath` are whatever they were when it
   * was made, which is exactly the thing an async path needs to check against.
   */
  const activeRef = useRef<{ repo: string | null; path: string | null }>({
    repo: null,
    path: null,
  });

  /** Zen: the page alone. Deliberately not persisted — it's a mood, not a setting. */
  const [zen, setZen] = useState(false);
  const [perf, setPerf] = useState(false);
  const [matterOpen, setMatterOpen] = useState(false);
  /** Where a new file is about to be created, while the name is being asked. */
  const [naming, setNaming] = useState<null | {
    repo: string;
    dir: string;
    template: Template;
  }>(null);
  /*
   * The templates the reader owns, read from `~/.plans/templates/` once at
   * launch. The bundled pair stands in until that answers — and goes on
   * standing in where there is no home directory to read, which is the test
   * harness — so ⌘N is never a keystroke that does nothing.
   */
  const [templates, setTemplates] = useState<Template[]>(bundledTemplates);
  const [templatesDir, setTemplatesDir] = useState("");
  /**
   * Open buffers, in the order they were opened. Switching writes any pending
   * edit and re-reads from disk, so a tab is a bookmark rather than a second
   * copy of the file — there is only ever one buffer, and it is the file.
   */
  const [tabs, setTabs] = useState<Tab[]>(() => stored<Tab[]>(KEY.tabs, []));

  /**
   * What each open buffer looked like on disk when we last read it.
   *
   * Keyed `repo::path`, and deliberately separate from `stamp` — that one is
   * about the buffer being edited, this one is about the tabs you are *not*
   * looking at. A file open in another tab that an agent or a `git checkout`
   * rewrites used to change with nothing said: only the active file was ever
   * stat'd, so the news arrived whenever you happened to click back.
   */
  const tabStamps = useRef<Map<string, string>>(new Map());

  /** Open buffers whose file has changed on disk since we read it. */
  const [outside, setOutside] = useState<Set<string>>(new Set());
  /** The mode belongs to the buffer, so it is a derivation of the tab, not
   *  state of its own — which is also what makes it survive a restart. A file
   *  that is not markdown must never sit in the writing surface, so "write"
   *  clamps to "source" for it — memory buffers excepted, since those are
   *  Write-only prose of the app's own making. */
  const storedView: View =
    tabs.find((t) => t.repo === activeRepoPath && t.path === activePath)?.view ?? "write";
  const view: View =
    storedView === "write" &&
    activePath &&
    activeRepoPath !== MEMORY &&
    !isMarkdownPath(activePath)
      ? "source"
      : storedView;
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
  /**
   * What the disk says the folders are, asked only in "show all files" mode.
   * The tree is built from files, so a folder holding nothing — or holding
   * only things the walk skips — never appears in it on its own.
   */
  const [diskDirs, setDiskDirs] = useState<Record<string, string[]>>({});
  /** A one-line question waiting on an answer: branch name, commit message. */
  const [asking, setAsking] = useState<null | {
    title: string;
    placeholder?: string;
    note?: string;
    confirm: string;
    multiline?: boolean;
    /** Prefilled, for a rename or anything else that edits what exists. */
    initial?: string;
    /** When emptying the box is itself an answer — clearing an alias, say. */
    allowEmpty?: boolean;
    run: (value: string) => void;
  }>(null);
  const [branches, setBranches] = useState<string[]>([]);
  /** `origin/name` branches with no local counterpart — set apart in the menu. */
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  /**
   * True while the lazy fetch is out. The menu keeps showing the list it had
   * and says it is refreshing, rather than an empty box that fills when git
   * gets around to it — three seconds is a glance's worth of patience and
   * nothing like a typist's.
   */
  const [branchesLoading, setBranchesLoading] = useState(false);
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

  /** What the tree shows as folders: the remembered empties, plus — in "show
   *  all files" mode — every folder the disk has. */
  const treeDirs = useMemo(() => {
    if (!Object.keys(diskDirs).length) return emptyDirs;
    const out: Record<string, string[]> = {};
    for (const r of new Set([...Object.keys(emptyDirs), ...Object.keys(diskDirs)]))
      out[r] = [...new Set([...(emptyDirs[r] ?? []), ...(diskDirs[r] ?? [])])];
    return out;
  }, [emptyDirs, diskDirs]);

  /** A fragment of HTML open for editing, or null. */
  const [htmlEdit, setHtmlEdit] = useState<HtmlEdit | null>(null);
  /**
   * Right-click on the page, patterned on the tree's menu.
   *
   * The selection is read when the menu opens and kept here, so the menu
   * offers what was true at the moment of the click rather than at the moment
   * of the press — clicking an item moves focus, and the selection with it.
   */
  const [pageMenu, setPageMenu] = useState<null | { x: number; y: number; selection: string }>(
    null,
  );
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

  // --- workspaces: the app as a client of the workspace server ----------------
  /** Who is signed in to the workspace server; null is signed out. */
  const [account, setAccount] = useState<Account | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  /** Open rooms by workspace id: one socket per document, for as long as its
   *  tab is open. Not state — a room is a live object, not a render input. */
  const rooms = useRef(new Map<string, Room>());
  /** Bumped when a room's status changes, so the chrome re-reads it. */
  const [, setRoomTick] = useState(0);
  /** A workspace being named, invited to, or copied out. */
  const [wsNaming, setWsNaming] = useState(false);
  const [wsInviting, setWsInviting] = useState<string | null>(null);
  const [wsCopying, setWsCopying] = useState<null | { id: string; repo: string; dir: string }>(null);
  /** The workspace whose share links are open, if any. */
  const [wsSharing, setWsSharing] = useState<string | null>(null);
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

  // Kept in step during render, like `openFileRef` below it.
  activeRef.current = { repo: activeRepoPath, path: activePath };

  const status = activeRepoPath ? (statusByRepo[activeRepoPath] ?? null) : null;

  /**
   * Warm the diff's committed side for every changed file, so clicking down
   * the git panel's list shows each diff at once instead of a "Reading…"
   * beat per file. One `git show` each, sequential so a long list never
   * floods the backend; `sameStatus` keeps the entries object stable, so
   * this only re-runs when the list itself (or HEAD, via epoch) moves.
   */
  useEffect(() => {
    const entries = status?.entries ?? [];
    if (!activeRepoPath || !entries.length) return;
    const repo = activeRepoPath;
    let live = true;
    void (async () => {
      for (const e of entries.slice(0, 100)) {
        if (!live) return;
        await prefetchHead(repo, e.path);
      }
    })();
    return () => {
      live = false;
    };
  }, [activeRepoPath, status?.entries, epoch]);

  /** Whoever git says is here, as the `@name` a comment carries. */
  const author = activeRepoPath ? (identityByRepo[activeRepoPath] ?? "") : "";

  /**
   * Point at some prose, comment on it. The comment goes in at the cursor —
   * right where the reader was looking — through `htmlBridge.comment`.
   */
  const newComment = useCallback(() => {
    const me = author;
    setAsking({
      title: "New comment",
      placeholder: "What needs saying?",
      note: me
        ? `Lands at the cursor, as <!-- @${me}: … -->. ⌘⇧M from anywhere in the page.`
        : "Lands at the cursor as an HTML comment. git config user.name would sign it.",
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

  /* --- the settings file ------------------------------------------------- */
  //
  // settings.json in the platform's config directory is where the settings
  // actually live; localStorage above is a warm start, so the theme is right on
  // the first frame instead of after an async round trip. The file wins any
  // disagreement, and every save writes both.

  /** Where it is, for the settings page's footer. Empty until the first read. */
  const [settingsPath, setSettingsPath] = useState("");
  /** Keys this build has no field for, written back untouched on every save. */
  const settingsExtras = useRef<Extras>({});
  /** The stamp of our own last write, so the poll can ignore it. */
  const settingsStamp = useRef(0);
  /** The text last known to be on disk — a save that would change nothing
   *  writes nothing, which is what keeps the poll quiet. */
  const settingsText = useRef<string | null>(null);
  /** One toast per broken save, not one per poll. */
  const settingsBroken = useRef(false);
  /** Until the first read lands, the file has not had its say. */
  const [settingsBooted, setSettingsBooted] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const file = await api.settingsRead();
        if (gone) return;
        setSettingsPath(file.path);
        if (file.text === null) {
          // No file yet: migration is this same code path with the arrow
          // reversed — whatever localStorage was holding becomes the file.
          const text = serializeSettings(settingsRef.current);
          settingsText.current = text;
          settingsStamp.current = await api.settingsWrite(text);
        } else {
          const { settings: onDisk, extras } = parseSettingsFile(file.text);
          settingsExtras.current = extras;
          settingsStamp.current = file.modified;
          settingsText.current = serializeSettings(onDisk, extras);
          setSettings(onDisk);
        }
      } catch (e) {
        // A file that will not read or parse is not a reason to start with
        // someone else's settings; the warm start stands, and they get told.
        if (!gone) notify(`Settings file: ${String(e)}`, "error");
      } finally {
        if (!gone) setSettingsBooted(true);
      }
    })();
    return () => {
      gone = true;
    };
  }, [notify]);

  // The schema beside the file, rewritten on every launch — that is what keeps
  // it describing the build actually running rather than the one that first
  // wrote it. Nothing depends on it succeeding.
  useEffect(() => {
    void api
      .settingsWriteSchema(`${JSON.stringify(SETTINGS_SCHEMA, null, 2)}\n`)
      .catch(() => {});
  }, []);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    if (!settingsBooted) return;
    const text = serializeSettings(settings, settingsExtras.current);
    if (text === settingsText.current) return;
    settingsText.current = text;
    void api
      .settingsWrite(text)
      .then((stamp) => {
        settingsStamp.current = stamp;
      })
      .catch((e) => notify(`Settings file: ${String(e)}`, "error"));
  }, [settings, settingsBooted, notify]);

  /**
   * Poll the stamp, reload when it moves. Editing the theme in another editor
   * and watching the window change on save is the moment this feature proves
   * itself — and it is how the agent in the chat panel changes your settings
   * when asked, with no new tool surface at all.
   *
   * It used to share `watchSeconds` with the document watcher, which broke it
   * in the one configuration that most needs it. `watchSeconds: 0` is a choice
   * about repository churn, and it turned off the only channel through which
   * the file can ever be turned back on: the write landed, the app never
   * looked, and the person learned that asking the agent for a dark theme is
   * flaky. So this poll runs unconditionally at its own gentle interval. A
   * quiet tick costs a `stat` rather than a read, which is what `settings_stat`
   * is for.
   *
   * A file that does not parse keeps the last good settings and says so. "You
   * have a typo" is recoverable; "your settings reset" is rage.
   */
  useEffect(() => {
    if (!settingsBooted) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          const stamp = await api.settingsStat();
          if (!stamp || stamp === settingsStamp.current) return;
          const file = await api.settingsRead();
          settingsStamp.current = file.modified;
          if (file.text === null) return;
          let parsed;
          try {
            parsed = parseSettingsFile(file.text);
          } catch {
            if (!settingsBroken.current) {
              settingsBroken.current = true;
              notify("settings.json doesn't parse — keeping the last settings", "error");
            }
            return;
          }
          settingsBroken.current = false;
          settingsExtras.current = parsed.extras;
          // The text on disk is theirs, not ours: recording what we would have
          // written stops the save effect from reformatting it straight back.
          settingsText.current = serializeSettings(parsed.settings, parsed.extras);
          // A knob turned in a text editor is a knob turned. Which ones matter
          // is the whole point of the counter, and a shallow compare over the
          // known keys is all the diffing that honesty needs here.
          for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
            const was = settingsRef.current[key];
            const now = parsed.settings[key];
            const same =
              was !== null && typeof was === "object"
                ? JSON.stringify(was) === JSON.stringify(now)
                : was === now;
            if (!same) noteSettingChange(key);
          }
          setSettings(parsed.settings);
        } catch {
          // Offline, mid-write, gone for a moment — the next tick asks again.
        }
      })();
    }, SETTINGS_POLL_MS);
    return () => clearInterval(id);
  }, [settingsBooted, notify]);

  const openSettingsFile = useCallback(() => {
    void api.settingsOpen().catch((e) => notify(String(e), "error"));
  }, [notify]);

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
        else if (asked)
          notify(`Looped Plans ${await runningVersion()} is the latest version`);
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
      track("update_installed");
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
  /*
   * The skills' user-level copies (`~/.plans/skills/`) stay fresh without a
   * button: they are app-owned mirrors of the bundle, not an install someone
   * chose. In a browser (the test harness) there is no home to write to and
   * the call fails quietly.
   */
  useEffect(() => {
    void api
      .syncUserSkills(SKILLS.map((k) => [k.name, k.text] as [string, string]))
      .catch(() => {});
  }, []);

  /*
   * The templates next door are read rather than written: the folder is seeded
   * the first time and belongs to the reader after that. Read once at launch —
   * a template is picked from a menu, and a menu that changes while it is open
   * is worse than one that is a launch out of date.
   */
  useEffect(() => {
    void loadTemplates().then((found) => {
      setTemplates(found.templates);
      setTemplatesDir(found.dir);
      if (found.skipped.length) {
        notify(`Skipped ${found.skipped.join(", ")}: no name in the frontmatter`, "error");
      }
    });
  }, [notify]);

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
    localStorage.setItem(KEY.repoNames, JSON.stringify(repoNames));
  }, [repoNames]);

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
        got.push([
          r.path,
          await api.listPlans(r.path, [""], settings.showIgnored, !settings.showAllFiles),
        ] as const);
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
    // All files means all folders too, empty ones included; the file walk
    // alone cannot show those. Markdown mode keeps the tree to what has files.
    if (settings.showAllFiles) {
      const dirs: Record<string, string[]> = {};
      for (const r of repos) {
        try {
          dirs[r.path] = await api.listDirs(r.path, settings.showIgnored);
        } catch {
          dirs[r.path] = [];
        }
      }
      setDiskDirs((prev) =>
        JSON.stringify(prev) === JSON.stringify(dirs) ? prev : dirs,
      );
    } else {
      setDiskDirs((prev) => (Object.keys(prev).length ? {} : prev));
    }
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
  }, [repos, settings.showIgnored, settings.showAllFiles]);

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
    async (kind: HandoffKind, repo?: string, path?: string) => {
      const r = repo ?? activeRepoPath;
      const f = path ?? activePath;
      if (!r || !f) return;
      // The chat is per-plan, so handing off a file that is not open has to
      // open it first — otherwise the seeded turn lands in another plan's
      // conversation.
      // Through the ref: `openFile` is declared further down, and this is the
      // same indirection the stale-tree retry already uses.
      if (r !== activeRepoPath || f !== activePath) await openFileRef.current?.(r, f);
      const prompt =
        kind === "implement"
          ? settings.implementPrompt || IMPLEMENT_PROMPT
          : settings.handoffPrompt || HANDOFF_PROMPT;
      setChatSeed(prompt.replace(/\{file\}/g, f));
      set({ showMux: true });
    },
    [activeRepoPath, activePath, set, settings.handoffPrompt, settings.implementPrompt],
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

  /**
   * A share link, minted and on the clipboard in one gesture: sharing and
   * asking for review are siblings, and neither should cost a detour through a
   * management page. The links this makes are listed and revocable in the
   * sheet behind the same control.
   */
  const copyShareLink = useCallback(
    async (id: string) => {
      try {
        const link = await workspace.share.mint(id);
        const url = workspace.shareUrl(link.token);
        await navigator.clipboard.writeText(url).then(
          () => notify("Share link copied"),
          () => notify("Could not write to the clipboard", "error"),
        );
      } catch (e) {
        notify(e instanceof Error ? e.message : "Could not mint a share link", "error");
      }
    },
    [notify],
  );

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
    setBranchesLoading(true);
    api
      .gitBranches(activeRepoPath)
      .then((b) => {
        if (!live) return;
        setBranches(b.branches);
        setRemoteBranches(b.remotes ?? []);
      })
      .catch(() => {
        if (!live) return;
        setBranches([]);
        setRemoteBranches([]);
      })
      .finally(() => live && setBranchesLoading(false));
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
      setRepoNames((prev) => {
        if (!(path in prev)) return prev;
        const { [path]: _gone, ...rest } = prev;
        return rest;
      });
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
   * Put a repository somewhere else on the shelf.
   *
   * The whole of the feature's state: the tree renders `repos` in array order,
   * and the effect below writes whatever order the array holds, so a splice is
   * both the reorder and its persistence. By path on the from side because the
   * tree drags `shownRepos`, an overlay-mapped copy whose indexes are not
   * these; by index on the to side because "between these two headings" is an
   * index and nothing else.
   */
  const reorderRepo = useCallback((fromPath: string, toIndex: number) => {
    setRepos((prev) => {
      const from = prev.findIndex((r) => r.path === fromPath);
      if (from === -1) return prev;
      const to = Math.max(0, Math.min(toIndex, prev.length - 1));
      if (to === from) return prev;
      const next = prev.slice();
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  }, []);

  /**
   * Give a repository the name the sidebar should use.
   *
   * The folder's name is sometimes the wrong answer — a worktree's directory,
   * or the third repository called `mono`. The alias is the app's own memory,
   * per path; emptying it goes back to the folder's name.
   */
  const renameRepo = useCallback(
    (path: string) => {
      const r = repos.find((x) => x.path === path);
      if (!r) return;
      setAsking({
        title: "Rename repository",
        placeholder: r.name,
        initial: repoNames[path] ?? r.name,
        note: `Only in this app — nothing on disk changes. Empty goes back to “${r.name}”.`,
        confirm: "Rename",
        allowEmpty: true,
        run: (next) => {
          const name = next.trim();
          setRepoNames((prev) => {
            if (!name || name === r.name) {
              if (!(path in prev)) return prev;
              const { [path]: _gone, ...rest } = prev;
              return rest;
            }
            return { ...prev, [path]: name };
          });
        },
      });
    },
    [repos, repoNames],
  );

  /**
   * What is already installed, so Settings can say so rather than offering the
   * same "Install" to someone who has pressed it. Both are read when Settings
   * opens and again after a press, because a button that does not change is a
   * button people press twice.
   */
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [agents, setAgents] = useState<AgentFound[]>([]);
  /**
   * What the agent has spent, per repository.
   *
   * Read here rather than in the panel because it belongs in the status bar:
   * context and cost are facts about the session, and the bar is where this
   * app already puts facts about the thing you are working in. It also means
   * the reading survives the panel being closed.
   */
  const [usage, setUsage] = useState<Record<string, { used: number; size: number; cost?: number }>>(
    {},
  );

  /**
   * The active repository's conversations.
   *
   * Held here rather than in the panel because the palette offers the same
   * ones its picker does, and two copies of that list would be two chances to
   * disagree about which chat you are in.
   */
  const [chats, setChats] = useState<ChatIndex>(() => loadChats(activeRepoPath ?? ""));
  useEffect(() => {
    setChats(loadChats(activeRepoPath ?? ""));
  }, [activeRepoPath]);

  /**
   * The current chat's advertised config options, mirrored from the same
   * `agent-config` event the chat panel consumes. The palette's routing
   * commands (`model:` / `effort:` frontmatter) offer only what the live
   * agent says it has — the vocabulary is the agent's ("gpt-5.6-sol" for
   * one, "opus" for another), so with no session advertising options there
   * are no commands, and the keys are set by hand in the frontmatter sheet.
   */
  const [agentOptionsBy, setAgentOptionsBy] = useState<Map<string, ConfigOption[]>>(
    () => new Map(),
  );
  useEffect(() => {
    // One listener for the app's lifetime, keeping every session's options:
    // the event fires once when a session opens, so a listener scoped to the
    // current chat would drop what fired for the others and have nothing when
    // you switch back.
    const un = listen<{ repo: string; chat: string; options: ConfigOption[] }>(
      "agent-config",
      (e) =>
        setAgentOptionsBy((m) =>
          new Map(m).set(`${e.payload.repo}\n${e.payload.chat}`, e.payload.options ?? []),
        ),
    );
    return () => void un.then((f) => f());
  }, []);
  const routingChoices = useMemo(() => {
    const opts = agentOptionsBy.get(`${activeRepoPath}\n${chats.current}`) ?? [];
    return {
      model: opts.find((o) => o.category === "model")?.options.map((c) => c.value) ?? [],
      effort: opts.find((o) => o.category === "thought_level")?.options.map((c) => c.value) ?? [],
    };
  }, [agentOptionsBy, activeRepoPath, chats]);

  const putChats = useCallback(
    (next: ChatIndex) => {
      if (activeRepoPath) saveChats(activeRepoPath, next);
      setChats(next);
    },
    [activeRepoPath],
  );

  /**
   * Start again.
   *
   * Nothing is ended. A new conversation is a new key, so whatever was running
   * carries on in the chat it belongs to — which is the point: setting an agent
   * going on a long job and starting a second while it works is the ordinary
   * thing this used to make impossible.
   */
  const newChat = useCallback(() => {
    putChats(startedChat(chats));
    set({ showMux: true });
  }, [chats, putChats, set]);

  const openChat = useCallback(
    (id: string) => {
      if (id === chats.current) return;
      // Only a change of which transcript is on screen. The conversation you
      // are leaving keeps its session, and keeps answering into its own
      // transcript while you read another.
      putChats({ ...chats, current: id });
      set({ showMux: true });
    },
    [chats, putChats, set],
  );

  /**
   * Every open repository's conversations, for the palette's "all" scope.
   *
   * Read from storage rather than held in state. Only one repository's chats
   * are ever being written, so re-reading a handful of keys is cheaper than
   * keeping every index in step with the one that moves — and it goes through
   * `peekIndex`, never `loadIndex`, because reading a list must not seed a
   * "New chat" in a repository nobody has spoken to.
   *
   * The active repository comes from `chats` instead, which is the one copy
   * that can be ahead of what is written. It is appended separately when it is
   * not among the repos at all, which is the case while a memory buffer is
   * open — otherwise turning the setting on would *lose* the conversation you
   * are actually in.
   */
  const allChats = useMemo(() => {
    const out = shownRepos.flatMap((r) => {
      const i = r.path === activeRepoPath ? chats : peekChats(r.path);
      return (i?.list ?? []).map((c) => ({
        repoPath: r.path,
        repoName: r.name,
        chat: c,
        local: r.path === activeRepoPath,
        current: c.id === i?.current,
      }));
    });
    if (activeRepoPath && !repos.some((r) => r.path === activeRepoPath)) {
      out.push(
        ...chats.list.map((c) => ({
          repoPath: activeRepoPath,
          repoName: "",
          chat: c,
          local: true,
          current: c.id === chats.current,
        })),
      );
    }
    return out;
  }, [shownRepos, activeRepoPath, chats]);

  /**
   * Open a conversation belonging to another repository.
   *
   * A chat is not something you can look at from outside its repository: the
   * transcript is keyed by repo, the agent is started in it, and the plans it
   * talks about are there. So going to one is going to the repository, and the
   * window follows.
   *
   * The target's index is written *before* the switch, because reloading the
   * index is exactly what switching does — write it after and the effect that
   * follows the active repo would put that repo's previous chat back.
   */
  const openChatIn = useCallback(
    (repoPath: string, id: string) => {
      if (repoPath === activeRepoPath) return openChat(id);
      const i = peekChats(repoPath);
      // Its index vanished between the palette reading it and this click.
      // Better to do nothing than to switch and mint a new conversation.
      if (!i) return;
      saveChats(repoPath, { ...i, current: id });
      setActiveRepoPath(repoPath);
      set({ showMux: true });
    },
    [activeRepoPath, openChat, set],
  );

  /**
   * Forget a conversation.
   *
   * Asked about only when there is something to lose: an empty chat is a
   * click to remake, and a confirmation for it is a question with one
   * sensible answer.
   */
  const deleteChat = useCallback(
    async (id: string) => {
      if (!activeRepoPath) return;
      const held = chatSize(activeRepoPath, id);
      const name = chats.list.find((c) => c.id === id)?.title ?? "this chat";
      if (held > 0 && !(await confirmed(`Delete “${name}”?`, { ok: "Delete" }))) return;
      /*
       * Its session goes with it, whether or not it was the one on screen.
       *
       * This is now the only navigation that ends anything, and it has to:
       * forgetting a transcript while its process keeps running leaves an
       * agent nobody can reach, read or stop — which is the one thing this app
       * promises not to leave behind.
       */
      void api.agentStop(activeRepoPath, id).catch(() => {});
      putChats(chatWithout(activeRepoPath, chats, id));
    },
    [activeRepoPath, chats, putChats],
  );

  /**
   * Name a conversation yourself.
   *
   * The automatic name is the first thing you said, which is usually right and
   * occasionally not — a chat that wandered somewhere else keeps a title about
   * where it started. A renamed chat stops following the transcript.
   */
  const renameChat = useCallback(
    (id: string) => {
      const at = chats.list.find((c) => c.id === id);
      if (!at) return;
      setAsking({
        title: "Rename chat",
        placeholder: at.title,
        initial: at.title,
        confirm: "Rename",
        run: (next) => {
          const title = next.trim();
          if (!title) return;
          putChats({
            ...chats,
            list: chats.list.map((c) => (c.id === id ? { ...c, title, named: true } : c)),
          });
        },
      });
    },
    [chats, putChats],
  );

  const nameChat = useCallback(
    (id: string, title: string) => {
      setChats((prev) => {
        const at = prev.list.find((c) => c.id === id);
        // A name you chose outranks the one the transcript suggests.
        if (!at || at.named || at.title === title) return prev;
        const next = { ...prev, list: prev.list.map((c) => (c.id === id ? { ...c, title } : c)) };
        if (activeRepoPath) saveChats(activeRepoPath, next);
        return next;
      });
    },
    [activeRepoPath],
  );

  /**
   * Which conversations have a live agent behind them.
   *
   * Not a policy and not a timer: a chat is active because a process exists and
   * archived because it does not, which is a fact only the session can report.
   * So it is recorded as the events arrive rather than inferred from what was
   * last clicked — and it is held here rather than in the panel, because the
   * panel can be closed while its agents carry on working.
   *
   * Nothing is restored on launch. A persisted "active" would be a claim about
   * a process that is not running: quitting leaves none behind.
   */
  const [running, setRunning] = useState<Record<string, number>>({});
  const runningCount = Object.keys(running).length;

  useEffect(() => {
    const up = listen<{ repo: string; chat: string; gen: number }>("agent-ready", (e) => {
      const { repo, chat, gen } = e.payload;
      setRunning((prev) => ({ ...prev, [`${repo}::${chat}`]: gen }));
    });
    const gone = listen<{ repo: string; chat: string; gen: number }>("agent-down", (e) => {
      const { repo, chat, gen } = e.payload;
      setRunning((prev) => {
        const k = `${repo}::${chat}`;
        // A farewell from a session already replaced by a newer one.
        if (!(k in prev) || (gen && gen < prev[k])) return prev;
        const next = { ...prev };
        delete next[k];
        return next;
      });
    });
    return () => {
      void up.then((f) => f());
      void gone.then((f) => f());
    };
  }, []);

  useEffect(() => {
    /*
     * Keyed by conversation, not by repository.
     *
     * Two sessions in one repository were writing over each other's reading,
     * so the bar showed whichever had spoken last under a label that said it
     * was the repository's. It shows the focused chat's, which is the one
     * whose context window the number is actually about.
     */
    const off = listen<{ repo: string; chat: string; used: number; size: number; cost?: number }>(
      "agent-usage",
      (e) => {
        const { repo, chat, used, size, cost } = e.payload;
        setUsage((prev) => ({ ...prev, [`${repo}::${chat}`]: { used, size, cost } }));
      },
    );
    return () => void off.then((f) => f());
  }, []);
  const [skills, setSkills] = useState<Record<string, SkillState>>({});

  /**
   * Where the agents on this machine read a repository's conventions.
   *
   * Held in a ref as well as in state. `readInstalls` needs the answer in the
   * same pass that fetches it, and making it depend on the `agents` state
   * instead would be a loop: the fetch replaces the array, the new array
   * changes the callback, and the effect that calls it fires again forever.
   */
  const agentPaths = useRef<string[]>([]);

  const readInstalls = useCallback(async () => {
    api.cliStatus().then(setCli, () => setCli(null));
    const found = await api.agentList().catch(() => [] as AgentFound[]);
    setAgents(found);
    /*
     * Only the agents this machine actually has. Writing `GEMINI.md` into a
     * repository for someone who has never run Gemini is litter — a file
     * nothing will read, arriving in their git status with no explanation.
     */
    agentPaths.current = [
      ...new Set(found.filter((a) => a.ready).flatMap((a) => a.conventions)),
    ];
    for (const r of repos) {
      void skillState(r.path, agentPaths.current).then((st) =>
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

  /** The write that is in the air, if one is: what a second flush has to wait for. */
  const flushing = useRef<Promise<boolean> | null>(null);

  const writeOut = useCallback(async (): Promise<boolean> => {
    const p = pending.current;
    if (!p) return true;
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
      return true;
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
          // No stamp means even the unconditional write failed.
          return stamp.current !== null;
        }
        // Put the edit back so no keystroke is lost while the reader decides.
        pending.current = p;
        const theirs = await api.readPlan(p.repo, p.path).then(
          (r) => r.content,
          () => "",
        );
        setConflict({ theirs });
        return false;
      }
      notify(String(e), "error");
      return false;
    } finally {
      writing.current = false;
    }
  }, [notify, refreshStatus, settings.autosave]);

  /**
   * Write the pending buffer out.
   *
   * Answers whether the buffer is on disk: `true` when the write landed (or
   * there was nothing to write), `false` when it was refused — a conflict, or
   * an error already shown. Most callers save because it is time to save and
   * can ignore the answer; one — the rewrite seed — is about to tell an agent
   * what the file contains, and must not say so when it doesn't.
   *
   * An empty pending slot is not on its own proof of anything: the autosave
   * timer may have taken the buffer a moment ago and still be waiting on the
   * write. So a flush first waits out the write already in the air and adopts
   * its answer — only then is "nothing pending" the same as "on disk".
   */
  const flush = useCallback(async (): Promise<boolean> => {
    // The keystrokes still inside the editor's typing debounce, first: without
    // this a flush within ~180ms of typing saw an empty pending slot, called
    // the buffer saved, and a rewrite went out quoting text not yet on disk.
    htmlBridge.collect?.();
    const inFlight = flushing.current;
    if (inFlight && !(await inFlight)) return false;
    if (!pending.current) return true;
    const run = writeOut();
    flushing.current = run;
    try {
      return await run;
    } finally {
      if (flushing.current === run) flushing.current = null;
    }
  }, [writeOut]);

  const onChange = useCallback(
    (markdown: string) => {
      // A dropped file's folder is a writable root like any repo; only a
      // memory buffer has nowhere to go.
      if (!activeRepoPath || activeRepoPath === MEMORY || !activePath) return;
      setContent(markdown);
      setDirty(true);
      pending.current = {
        repo: activeRepoPath,
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
    [activeRepoPath, activePath, flush, matter, settings.autosave, settings.autosaveDelay],
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

  /**
   * Rewrite the selected passage, by asking the agent to.
   *
   * A third seed on the path handoff already walks: the turn names the file,
   * quotes the passage and carries the instruction, and the agent edits the
   * file the way every other handoff does — the stamp poll notices the write
   * and reloads a clean buffer. Nothing splices text into the document behind
   * the save-and-watch machinery's back.
   *
   * The buffer is flushed first. `handOff` gets away without it because it
   * points at the whole file; this points *into* one, and a quote from a file
   * the agent cannot see is a quote it cannot find. If the flush is refused —
   * a conflict, a failed write — there is no turn to send: the quote would
   * describe a file that doesn't exist, and the agent would go rewrite
   * whatever it found instead. The conflict bar is already on screen saying
   * what happened.
   */
  const rewriteSelection = useCallback(
    (selection: string) => {
      const text = selection.replace(/\s+$/, "");
      const r = activeRepoPath;
      const f = activePath;
      if (!text || !r || !f) return;
      setAsking({
        title: "Rewrite",
        placeholder: "What should change about it?",
        note: "Sent to the agent, which edits the file — the page reloads when it lands.",
        confirm: "Rewrite",
        multiline: true,
        run: (value) => {
          const ask = value.trim();
          if (!ask) return;
          void (async () => {
            if (!(await flush())) return;
            // The sheet closed before the write finished, so the buffer
            // underneath may have changed while we waited. The chat is
            // per-file: a seed naming this file has to land in this file's
            // conversation, so bring it back first — the same thing `handOff`
            // does when it is asked about a file that isn't open.
            if (activeRef.current.repo !== r || activeRef.current.path !== f) {
              // A memory buffer is not on disk, so there is nothing to bring
              // back and nothing the agent could read: drop the turn instead.
              if (r === MEMORY) return;
              await openFileRef.current?.(r, f);
            }
            const fields: Record<string, string> = {
              file: f,
              lines: lineHint(source, text),
              ask,
              quote: quoteBlock(text),
            };
            const template = settings.rewritePrompt || REWRITE_PROMPT;
            // One pass, and through a function: the quote is someone's prose,
            // and `$&` in it must not turn into a substitution of its own.
            setChatSeed(template.replace(/\{(file|lines|ask|quote)\}/g, (m, k) => fields[k] ?? m));
            set({ showMux: true });
          })();
        },
      });
    },
    [activeRepoPath, activePath, flush, set, settings.rewritePrompt, source],
  );

  const onSourceChange = useCallback(
    (text: string) => {
      if (!activeRepoPath || activeRepoPath === MEMORY || !activePath) return;
      // The same rule as opening: frontmatter is a markdown convention, so a
      // YAML file that happens to start with `---` keeps its header in the body.
      const split = settings.showFrontmatter && isMarkdownPath(activePath)
        ? splitFrontmatter(text)
        : { matter: null, body: text };
      setMatter(split.matter);
      setContent(split.body);
      setDirty(true);
      pending.current = { repo: activeRepoPath, path: activePath, text };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (settings.autosave === "afterDelay") {
        saveTimer.current = window.setTimeout(
          () => void flush(),
          Math.round(settings.autosaveDelay * 1000),
        );
      }
    },
    [
      activeRepoPath,
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
    (next: View, focusedOnly = false) => {
      // Write is for markdown alone. ⌘1 on anything else does nothing rather
      // than silently switching — Milkdown would rewrite the file on save.
      const target =
        focusedOnly && paneRoute.current.split && paneRoute.current.paneFocus === "split"
          ? paneRoute.current.split.path
          : activePath;
      if (
        next === "write" &&
        target &&
        activeRepoPath !== MEMORY &&
        !isMarkdownPath(target)
      )
        return;
      if (focusedOnly && paneRoute.current.split) {
        if (paneRoute.current.paneFocus === "split") {
          // Pin the split alone; the main pane stays where it is.
          setSplitOverride(next);
          return;
        }
        // Pin the split where it stands, so changing the main pane alone
        // does not drag it along.
        setSplitOverride((cur) => cur ?? viewNow.current);
      } else if (!focusedOnly) {
        // The plain switch is global: one state, both panes, override gone.
        // A split buffer with nothing to diff against falls back to Source.
        setSplitOverride(null);
      }
      // The view switch offers what the buffer can do: a dropped file has no
      // repository, so there is nothing for Diff to compare against.
      if (next === "diff" && !repos.some((r) => r.path === activeRepoPath)) return;
      if (next === "source" && view !== "source") sourceOnEntry.current = source;
      if (next === "write" && view === "source" && activePath) {
        const changed = sourceOnEntry.current !== null && sourceOnEntry.current !== source;
        if (changed) setDocKey(`${activeRepoPath}::${activePath}::${Date.now()}`);
        sourceOnEntry.current = null;
      }
      setBufferView(next);
    },
    [activePath, activeRepoPath, source, view, setBufferView, repos],
  );

  /** Editing the metadata block saves on the same terms as editing the prose. */
  const onMatterChange = useCallback(
    (next: string | null) => {
      if (!activeRepoPath || activeRepoPath === MEMORY || !activePath) return;
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
      const before = matterValue(lastMatter.current ?? "", "status") || null;
      lastMatter.current = next;
      if (status !== before) {
        // The vocabulary is the user's own, so the word stays here: report
        // its place in the configured list, and whether it means finished.
        const choice = settings.statuses
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .indexOf((status ?? "").toLowerCase());
        track("plan_status_changed", {
          cleared: status === null,
          done: isDone(status),
          choice,
          fromDone: isDone(before),
        });
      }
      setFilesByRepo((prev) => {
        const files = prev[activeRepoPath];
        if (!files) return prev;
        const i = files.findIndex((f) => f.relPath === activePath);
        if (i === -1 || files[i].status === status) return prev;
        const copy = files.slice();
        copy[i] = { ...copy[i], status };
        return { ...prev, [activeRepoPath]: copy };
      });
      pending.current = {
        repo: activeRepoPath,
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
    [activeRepoPath, activePath, content, flush, settings.autosave, settings.autosaveDelay, settings.statuses],
  );
  /** The block as last written through here, so a status edit can be told from a re-save. */
  const lastMatter = useRef<string | null>(null);
  useEffect(() => {
    lastMatter.current = matter;
  }, [matter, activePath, activeRepoPath]);

  /**
   * The order the tree puts files in, when it is ordered by status at all.
   *
   * Lowercased here rather than at the comparison, so the tree does one cheap
   * `indexOf` per file instead of a case fold per file per render. Empty when
   * the setting is off, which is also what tells the tree to order by name.
   */
  const statusOrder = useMemo(
    () =>
      settings.treeSort === "status"
        ? settings.statuses
            .split(",")
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean)
        : [],
    [settings.treeSort, settings.statuses],
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

  /** Write a routing key (`model:` / `effort:`) the same way `setStatus` does. */
  const setRouting = useCallback(
    (key: "model" | "effort", value: string | null) => {
      const next = setMatterValue(matter ?? "", key, value);
      onMatterChange(next.trim().length ? next : null);
      track("plan_routing_changed", { key, cleared: value === null });
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

  // --- the split pane ------------------------------------------------------
  // Two panes and no more. The second is self-contained (`SplitPane.tsx`);
  // what lives here is only which file it shows, which way the split runs,
  // where the divider sits, and which pane a keystroke belongs to.
  const [split, setSplit] = useState<{ repo: string; path: string } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY.split) ?? "null");
    } catch {
      return null;
    }
  });
  const [splitDir, setSplitDir] = useState<"row" | "column">(() =>
    localStorage.getItem(KEY.splitDir) === "column" ? "column" : "row",
  );
  const [splitRatio, setSplitRatio] = useState(() => {
    const n = Number(localStorage.getItem(KEY.splitRatio));
    return n >= 0.15 && n <= 0.85 ? n : 0.5;
  });
  const [paneFocus, setPaneFocus] = useState<"main" | "split">("main");
  /**
   * The split pane's own tab set. Each pane keeps its own list — one shared
   * strip acting on "the focused pane" read as one pane's tabs leaking into
   * the other's chrome.
   */
  const [splitTabs, setSplitTabs] = useState<{ repo: string; path: string }[]>(() => {
    try {
      const list = JSON.parse(localStorage.getItem(KEY.splitTabs) ?? "[]") as {
        repo: string;
        path: string;
      }[];
      const tabs = Array.isArray(list) ? list : [];
      // The pane's current file always has a tab, whatever storage says.
      const cur = JSON.parse(localStorage.getItem(KEY.split) ?? "null") as {
        repo: string;
        path: string;
      } | null;
      if (cur && !tabs.some((t) => t.repo === cur.repo && t.path === cur.path)) {
        tabs.push(cur);
      }
      return tabs;
    } catch {
      return [];
    }
  });
  /**
   * The split pane's view *override*. Null follows the global switch — one
   * state, both panes — and a value pins this pane: the same file can sit
   * rich on one side and raw on the other. ⌥-click on the switch (or the
   * palette's "This pane" commands) sets it; a plain click clears it.
   */
  const [splitOverride, setSplitOverride] = useState<"write" | "source" | "diff" | null>(null);
  const splitFlush = useRef<(() => Promise<void>) | null>(null);

  /**
   * The one door into the split: sets the file, keeps its tab, takes focus.
   * `at` places the tab (a drop knows where it landed); without it a tab the
   * strip already has stays put, and a new one joins the end.
   */
  const openSplitFile = useCallback((repo: string, path: string, at?: number) => {
    setSplit({ repo, path });
    setSplitTabs((prev) => {
      const has = prev.some((t) => t.repo === repo && t.path === path);
      if (at === undefined) return has ? prev : [...prev, { repo, path }];
      const without = prev.filter((t) => !(t.repo === repo && t.path === path));
      const i = Math.max(0, Math.min(at, without.length));
      return [...without.slice(0, i), { repo, path }, ...without.slice(i)];
    });
    setPaneFocus("split");
  }, []);

  /** Close one of the split's tabs; the last one closes the pane with it. */
  const closeSplitTab = useCallback(
    (repo: string, path: string) => {
      const rest = splitTabs.filter((t) => !(t.repo === repo && t.path === path));
      setSplitTabs(rest);
      setSplit((cur) => {
        if (!cur || cur.repo !== repo || cur.path !== path) return cur;
        return rest.length ? rest[rest.length - 1] : null;
      });
    },
    [splitTabs],
  );
  useEffect(() => {
    localStorage.setItem(KEY.split, JSON.stringify(split));
    if (!split) setPaneFocus("main");
  }, [split]);
  useEffect(() => localStorage.setItem(KEY.splitTabs, JSON.stringify(splitTabs)), [splitTabs]);
  useEffect(() => localStorage.setItem(KEY.splitDir, splitDir), [splitDir]);
  useEffect(() => localStorage.setItem(KEY.splitRatio, String(splitRatio)), [splitRatio]);
  /**
   * What `openFile` needs to route without re-creating itself: opening a file
   * while the split has focus loads it there, and a file already open in the
   * other pane moves focus rather than opening a second copy — two editors
   * saving one file against two stamps is the conflict machinery firing on
   * the app's own edits.
   */
  const paneRoute = useRef({ split, paneFocus, activeRepoPath, activePath });
  paneRoute.current = { split, paneFocus, activeRepoPath, activePath };
  /** The main pane's current view, readable from callbacks defined earlier. */
  const viewNow = useRef<View>("write");
  viewNow.current = view;
  /** The main buffer's assembled text, for same-file mirroring and watchers. */
  const sourceNow = useRef("");
  sourceNow.current = source;

  /** Opening a file in another repository makes that repository the active one. */
  const openFile = useCallback(
    async (
      repoPath: string,
      relPath: string,
      retrying = false,
      direct = false,
      // The mode to land in. Without it, opening from the git panel mounted
      // the writing surface first — a full markdown parse — only to tear it
      // down when the tab flipped to Diff a beat later.
      mode?: View,
    ) => {
      if (!direct && !retrying) {
        const r = paneRoute.current;
        if (r.split && r.paneFocus === "split") {
          if (repoPath === r.activeRepoPath && relPath === r.activePath) {
            setPaneFocus("main");
            return;
          }
          if (repoPath === MEMORY) {
            // Memory buffers live in the main pane's plumbing alone.
            setPaneFocus("main");
          } else {
            openSplitFile(repoPath, relPath);
            return;
          }
        } else if (r.split && r.split.repo === repoPath && r.split.path === relPath) {
          setPaneFocus("split");
          return;
        }
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flush();
      try {
        const { content: text, stamp: at } = await api.readPlan(repoPath, relPath);
        stamp.current = at;
        // Reading it is the answer to "has this changed since I read it".
        tabStamps.current.set(`${repoPath}::${relPath}`, at);
        setOutside((prev) => {
          const key = `${repoPath}::${relPath}`;
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setConflict(null);
        // With the block turned off the YAML simply stays in the prose, where
        // the editor can still reach it — hidden and uneditable would be worse.
        // Frontmatter is a markdown convention: a YAML file that happens to
        // open with `---` is not carrying any.
        const md = isMarkdownPath(relPath);
        const split =
          settings.showFrontmatter && md
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
        // Markdown keeps whatever mode the buffer was left in; anything else
        // opens in Source, the only surface that will not rewrite it.
        setTabs((prev) => {
          const next = prev.some((t) => t.repo === repoPath && t.path === relPath)
            ? prev
            : [...prev, { repo: repoPath, path: relPath }];
          if (mode)
            return next.map((t) =>
              t.repo === repoPath && t.path === relPath ? { ...t, view: mode } : t,
            );
          return md
            ? next
            : next.map((t) =>
                t.repo === repoPath && t.path === relPath && t.view !== "diff"
                  ? { ...t, view: "source" as View }
                  : t,
              );
        });
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
    [flush, notify, settings.showFrontmatter, refreshFiles, openSplitFile],
  );

  /**
   * Open a bundled skill's installed copy from the palette.
   *
   * Resolved at press time rather than baked into the command: where the copy
   * lives depends on which agents this machine has, and the answer used to be
   * assumed to be Claude Code's path — a command that opened nothing for
   * everyone else.
   */
  const openSkill = useCallback(
    async (name: string) => {
      if (!activeRepoPath) return;
      // The agents' paths are read lazily — the settings page is what
      // usually populates them, and the palette must not depend on it having
      // been opened first.
      if (!agentPaths.current.length) await readInstalls();
      const path = await skillFileFor(activeRepoPath, agentPaths.current, name);
      if (path) return openFileRef.current?.(activeRepoPath, path);
      notify(`The ${name} skill is not installed here — install the conventions from Settings`, "info");
    },
    [activeRepoPath, notify, readInstalls],
  );

  /**
   * A file dragged in from outside the app.
   *
   * Tauri's own drag-drop events, which carry real filesystem paths — the
   * HTML5 route hands over a `File` with no path, readable but never writable
   * back, and "edit in place" needs the place. A dropped markdown file that
   * lives inside an open repository opens as that repository's file, diff and
   * all; one from anywhere else opens with its folder as its root — the same
   * `(root, name)` shape every command already takes, so the watcher,
   * autosave and the stamp check all just work. A dropped folder is the
   * add-a-repository gesture by other means.
   */
  const dropPath = useCallback(
    async (raw: string) => {
      const path = raw.replace(/\/+$/, "");
      if (/\.(md|markdown|mdx)$/i.test(path)) {
        const inRepo = repos.find((r) => path.startsWith(`${r.path.replace(/\/+$/, "")}/`));
        if (inRepo) {
          await openFile(inRepo.path, path.slice(inRepo.path.length + 1), false, true);
          return;
        }
        const cut = path.lastIndexOf("/");
        if (cut <= 0) return;
        await openFile(path.slice(0, cut), path.slice(cut + 1), false, true);
        return;
      }
      // No extension reads as a folder; openRepo says no to anything that isn't.
      if (!/\.[A-Za-z0-9]+$/.test(path)) {
        await openRepoPath(path);
        return;
      }
      notify("Only markdown opens here — that file keeps its own app", "error");
    },
    [repos, openFile, openRepoPath, notify],
  );
  useEffect(() => {
    // In a plain browser (the test harness) there is no webview to ask.
    let un: Promise<() => void>;
    try {
      un = getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        for (const p of event.payload.paths) void dropPath(p);
      });
    } catch {
      return;
    }
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, [dropPath]);


  /**
   * ⌘-click on a link in the page. A scheme goes to the system browser; a
   * relative path resolves against the open file's folder, and another
   * markdown file opens right here — the folder of plans linking to each
   * other is the point of the folder.
   */
  const followLink = useCallback(
    (repo: string, from: string, href: string) => {
      if (!href || href.startsWith("#")) return;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        void openUrl(href).catch((e) => notify(String(e), "error"));
        return;
      }
      const clean = decodeURI(href.split(/[?#]/)[0]);
      const parts = from.includes("/") ? from.split("/").slice(0, -1) : [];
      for (const seg of clean.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      const rel = parts.join("/");
      if (/\.(md|markdown|mdx)$/i.test(rel)) void openFile(repo, rel);
      else void api.revealInFinder(repo, rel).catch(() => notify(`Not a markdown file: ${rel}`, "error"));
    },
    [openFile, notify],
  );

  /**
   * The split pane typing into the file the main pane is showing.
   *
   * Same-file panes mirror instantly rather than waiting for the watcher:
   * the pane being typed in owns the buffer and the save; this side adopts
   * the text with nothing pending and nothing dirty. Source and diff redraw
   * from props; a Write view is a built document, so it is rebuilt on a
   * short trailing debounce instead of every keystroke.
   */
  const mirrorTimer = useRef<number | undefined>(undefined);
  const adoptFromSplit = useCallback(
    (text: string) => {
      const r = paneRoute.current;
      if (!r.activeRepoPath || !r.activePath) return;
      if (text === sourceNow.current) return;
      const sp = settings.showFrontmatter
        ? splitFrontmatter(text)
        : { matter: null, body: text, raw: "" };
      original.current = { matter: sp.matter, raw: sp.raw, eol: /\n$/.test(text) };
      pending.current = null;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setMatter(sp.matter);
      setContent(sp.body);
      setDirty(false);
      if (viewNow.current === "write") {
        clearTimeout(mirrorTimer.current);
        mirrorTimer.current = window.setTimeout(
          () => setDocKey(`${r.activeRepoPath}::${r.activePath}::${Date.now()}`),
          250,
        );
      }
    },
    [settings.showFrontmatter],
  );

  /**
   * Where the reader was, per buffer.
   *
   * Opening a file rebuilds the editor, and a rebuilt editor starts at the
   * top — so jumping between two documents reset both. The position is
   * remembered per `repo::path` and put back once the document has actually
   * been built, which for Milkdown is a few frames after the mount: setting
   * scrollTop on an empty host clamps to zero, so the restore retries until
   * the content is tall enough to take it.
   */
  const scrollPos = useRef(new Map<string, { top: number; range: number; view: string }>());
  useEffect(() => {
    if (!activeRepoPath || !activePath) return;
    /*
     * The scrolling element depends on the mode: Write and Diff scroll the
     * editor host, Source scrolls CodeMirror's own scroller. Only the visible
     * surface's element counts — both stay mounted, and the hidden one is the
     * wrong thing to either restore into or listen to.
     */
    const host = document.querySelector<HTMLElement>(
      view === "source"
        ? ".main-pane .surface:not(.aside) .cm-scroller"
        : ".main-pane .editor-host",
    );
    if (!host) return;
    const k = `${activeRepoPath}::${activePath}`;
    const saved = scrollPos.current.get(k);
    const across = !!saved && saved.view !== view && saved.range > 0;
    let tries = 0;
    let lastHeight = -1;
    const restore = window.setInterval(() => {
      tries += 1;
      const range = host.scrollHeight - host.clientHeight;
      /*
       * A fraction of a range that is still growing lands short, so a
       * cross-mode restore waits for two ticks of the same height — a pixel
       * restore can keep the old rule, which is simply "tall enough yet".
       */
      if (across && host.scrollHeight !== lastHeight && tries <= 20) {
        lastHeight = host.scrollHeight;
        return;
      }
      /*
       * The same place, not the same number. Write and Source lay the same
       * text out at different heights, so a position saved in one mode is
       * carried into the other as a fraction of the scrollable range — which
       * is what keeps the two modes in sync on the same file. Within a mode
       * the exact pixel is kept.
       */
      const want =
        !saved ? 0 : saved.view === view || !saved.range ? saved.top : (saved.top / saved.range) * range;
      if (want <= range) {
        host.scrollTop = want;
        clearInterval(restore);
      } else if (tries > 20) {
        clearInterval(restore);
      }
    }, 40);
    const onScroll = () =>
      scrollPos.current.set(k, {
        top: host.scrollTop,
        range: host.scrollHeight - host.clientHeight,
        view,
      });
    host.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearInterval(restore);
      host.removeEventListener("scroll", onScroll);
    };
  }, [docKey, activeRepoPath, activePath, view]);

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
        // The other pane's autosave of this same text is not news: take the
        // stamp and stay put, so nothing rebuilds under the reader.
        const theirs = await api.readPlan(activeRepoPath, activePath).catch(() => null);
        if (theirs && theirs.content === sourceNow.current) {
          stamp.current = theirs.stamp;
          return;
        }
        await openFile(activeRepoPath, activePath, false, true);
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
   * Watch the buffers you are *not* looking at.
   *
   * The stamp poll above only ever stat'd `activePath`, so a plan open in
   * another tab could be rewritten underneath the app — by an agent, or by a
   * `git checkout` — and nothing would say so. You found out by clicking the
   * tab, which is the worst moment to be told: the change is old by then, and
   * if the buffer had unsaved work it raised a conflict about an edit that
   * happened minutes ago.
   *
   * A background tab holds no text — switching to one re-reads from disk — so
   * there is nothing to reload and nothing to lose. What was missing was only
   * the *telling*, which is why this marks the tab rather than acting on it.
   *
   * Deliberately on the slow tick. The tree walk is staggered the same way
   * (`SLOW`) because polling every open file at the watch interval is how the
   * app got slow the last time; a `stat` per tab every few seconds is cheap,
   * but it is not free and nothing here is urgent.
   */
  useEffect(() => {
    if (settings.watchSeconds <= 0) return;
    let n = 0;
    const t = setInterval(async () => {
      if (++n % SLOW !== 0) return;
      const watching = tabs.filter(
        (b) =>
          b.repo !== MEMORY &&
          !(b.repo === activeRepoPath && b.path === activePath),
      );
      // Tabs that have gone keep no stamp; otherwise the map grows forever.
      const live = new Set(tabs.map((b) => `${b.repo}::${b.path}`));
      for (const key of [...tabStamps.current.keys()]) {
        if (!live.has(key)) tabStamps.current.delete(key);
      }
      if (!watching.length) return;
      const seen = await Promise.all(
        watching.map(async (b) => {
          const at = await api.statPlan(b.repo, b.path).catch(() => null);
          return { key: `${b.repo}::${b.path}`, at };
        }),
      );
      setOutside((prev) => {
        const next = new Set(prev);
        let moved = false;
        for (const { key, at } of seen) {
          /*
           * `absent` is a stamp like any other to a string comparison, and
           * treating it as one is what once made a renamed file unwritable.
           * A file that is gone is not a file that changed, and a tab for it
           * is a separate question this poll does not answer.
           */
          if (!at || at === "absent") continue;
          const was = tabStamps.current.get(key);
          if (was === undefined) {
            // First sight of this tab: adopt what is there rather than
            // announcing a change we have no baseline for.
            tabStamps.current.set(key, at);
            continue;
          }
          if (was === at || next.has(key)) continue;
          next.add(key);
          moved = true;
        }
        return moved ? next : prev;
      });
    }, Math.max(1, settings.watchSeconds) * 1000);
    return () => clearInterval(t);
  }, [tabs, activeRepoPath, activePath, settings.watchSeconds]);


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

  /** Ask the server which rooms are ours; nothing, when signed out. */
  const refreshWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await workspace.list());
    } catch (e) {
      trace("workspace list failed", { error: String(e) });
    }
  }, []);

  // Who we are, once — the keychain answers, then the server confirms.
  useEffect(() => {
    if (!workspacesConfigured()) return;
    void workspace
      .me()
      .then((who) => {
        setAccount(who);
        if (who) void refreshWorkspaces();
      })
      .catch((e) => trace("workspace me failed", { error: String(e) }));
  }, [refreshWorkspaces]);

  // An invite arrives while you are elsewhere; coming back is when to look.
  useEffect(() => {
    if (!account) return;
    const onFocus = () => void refreshWorkspaces();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [account, refreshWorkspaces]);

  /**
   * Open a workspace's document as a buffer.
   *
   * The room is opened first and kept for as long as the tab is; the buffer
   * is a memory buffer whose text the editor takes from the room rather than
   * from what is passed here. The name is the template for an empty document,
   * which is all a new workspace has.
   */
  const openWorkspace = useCallback(
    async (ws: Workspace) => {
      if (!account) return;
      let room = rooms.current.get(ws.id);
      track("workspace_opened", { fresh: !room, workspaces: workspaces.length });
      if (!room) {
        const session = await workspaceToken();
        if (!session) return;
        room = openRoom(ws.id, session, { name: account.name ?? account.login, color: colorFor(account.login) });
        rooms.current.set(ws.id, room);
        room.onReview((review) =>
          setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? { ...w, review } : w))),
        );
        room.onStatus(() => setRoomTick((n) => n + 1));
      }
      await openMemory(`${WS_PREFIX}${ws.id}`, `# ${ws.name}\n`);
    },
    [account, openMemory, workspaces.length],
  );

  /** Sign out: the session goes from the server and the keychain, and every
   *  open room closes — its socket carried that session. */
  const signOut = useCallback(async () => {
    if (!(await confirmed(`Sign out of workspaces as ${account?.login}?`, { ok: "Sign out", kind: "info" }))) return;
    for (const [id, room] of rooms.current) {
      room.close();
      rooms.current.delete(id);
    }
    await workspace.signOut();
    track("signed_out");
    setAccount(null);
    setWorkspaces([]);
    setTabs((prev) => prev.filter((t) => !wsIdOf(t.path)));
    if (wsIdOf(activePath)) {
      setActivePath(null);
      setContent("");
      setMatter(null);
    }
  }, [account, activePath]);

  /** A new room with only us in it, opened straight away. */
  const makeWorkspace = useCallback(
    async (name: string) => {
      setWsNaming(false);
      try {
        const ws = await workspace.create(name);
        track("workspace_created", { workspaces: workspaces.length + 1 });
        setWorkspaces((prev) => [ws, ...prev]);
        await openWorkspace(ws);
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [openWorkspace, notify, workspaces.length],
  );

  const inviteTo = useCallback(
    async (id: string, login: string) => {
      setWsInviting(null);
      try {
        const ws = await workspace.invite(id, login.trim());
        setWorkspaces((prev) => prev.map((w) => (w.id === id ? ws : w)));
        track("workspace_invited");
        notify(`Invited ${login.trim().toLowerCase()}`);
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [notify],
  );

  /** Request, approve, or ask for changes. The server holds the author rule. */
  const reviewAct = useCallback(
    async (id: string, action: "request" | "approve" | "changes" | "clear") => {
      try {
        const review = await workspace.review(id, action);
        track("workspace_review", { action });
        setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, review } : w)));
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [notify],
  );

  /**
   * The bridge out of the room: the document, as markdown, into a repository.
   *
   * A snapshot, not a move — the room stays, and the file begins an ordinary
   * git life. The review's outcome goes into the frontmatter on the way out:
   * an approved plan lands `ready` with `approved-by:` saying who, which is
   * the point at which history, not the server, is what makes it tamper-
   * evident.
   */
  const copyWorkspaceOut = useCallback(
    async (id: string, repoPath: string, relPath: string) => {
      setWsCopying(null);
      const ws = workspaces.find((w) => w.id === id);
      const room = rooms.current.get(id);
      htmlBridge.collect?.();
      const text =
        mainWriteMarkdown.current?.() ??
        room?.doc.getMap<string>("meta").get("markdown") ??
        "";
      let out = text;
      if (ws?.review.state === "approved" && ws.review.decidedBy) {
        const split = splitFrontmatter(text);
        let matter = split.matter ?? "";
        matter = setMatterValue(matter, "status", "ready");
        matter = setMatterValue(matter, "approved-by", ws.review.decidedBy);
        out = joinFrontmatter(matter, split.body, split);
      }
      try {
        await api.createFile(repoPath, relPath, out);
        localStorage.setItem(
          `plans.newPlanDir::${repoPath}`,
          relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
        );
        await refreshFiles();
        await openFile(repoPath, relPath);
        void refreshStatus();
        notify(`Copied to ${relPath}`);
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [workspaces, refreshFiles, openFile, refreshStatus, notify],
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
      const title = fresh.length && seen ? `# What changed since ${seen}` : `# Looped Plans ${running}`;
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

  /**
   * Step to the next buffer, or the previous one, wrapping at both ends.
   *
   * Shared by ⌃Tab and ⌘⌥←/→ rather than written twice: they are the same
   * intent with two spellings, and the pair drifted apart the moment one of
   * them learned something the other did not. A memory buffer is reopened from
   * what the app is holding — it has no file to read, and sending it through
   * `openFile` would fail to find one.
   */
  const cycleTab = useCallback(
    (step: number) => {
      // Each pane cycles its own strip — the split's tabs are its business.
      if (paneFocus === "split" && split) {
        if (splitTabs.length < 2) return;
        const i = splitTabs.findIndex((t) => t.repo === split.repo && t.path === split.path);
        const next = splitTabs[(i + step + splitTabs.length) % splitTabs.length];
        if (next) openSplitFile(next.repo, next.path);
        return;
      }
      if (tabs.length < 2) return;
      const i = tabs.findIndex((t) => t.repo === activeRepoPath && t.path === activePath);
      const next = tabs[(i + step + tabs.length) % tabs.length];
      if (!next) return;
      void (next.repo === MEMORY
        ? openMemory(next.path, memoryDocs.current.get(next.path) ?? "")
        : openFile(next.repo, next.path, false, true));
    },
    [tabs, activeRepoPath, activePath, openFile, openMemory, paneFocus, split, splitTabs, openSplitFile],
  );

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
      // A workspace's text is on the server; what closes here is the line.
      const wsId = wsIdOf(path);
      if (wsId) {
        rooms.current.get(wsId)?.close();
        rooms.current.delete(wsId);
      }
      if (repo !== activeRepoPath || path !== activePath) return;
      const next = rest[Math.min(i, rest.length - 1)];
      setConflict(null);
      setMatterOpen(false);
      if (next) {
        // Direct: this is the main pane's own bookkeeping, wherever focus is.
        await (next.repo === MEMORY
          ? openMemory(next.path, memoryDocs.current.get(next.path) ?? "")
          : openFile(next.repo, next.path, false, true));
      } else {
        setActivePath(null);
        setContent("");
        setMatter(null);
      }
    },
    [tabs, flush, activeRepoPath, activePath, openFile, openMemory],
  );

  /**
   * A file dropped on the editor's far edge — the pointing way to ⌘\.
   *
   * A move, not a copy: if the main strip holds the file — the open document
   * included — it gives it up, the next tab fills its place (or the blank
   * state shows), and the file carries on in the split. One file, one pane.
   */
  const openInSplit = useCallback(
    async (repo: string, path: string, at?: number) => {
      if (tabs.some((t) => t.repo === repo && t.path === path)) {
        await closeTab(repo, path);
      }
      openSplitFile(repo, path, at);
    },
    [tabs, closeTab, openSplitFile],
  );

  /**
   * Swap the panes wholesale: the main strip's set and the split's trade
   * places, each pane showing what the other did. Memory buffers sit out —
   * they live in the main pane's plumbing and cannot cross.
   */
  const swapPanes = useCallback(async () => {
    if (!split) return;
    const memTabs = tabs.filter((t) => t.repo === MEMORY);
    const fileTabs = tabs.filter((t) => t.repo !== MEMORY);
    const toMain = split;
    const toSplit =
      activeRepoPath && activePath && activeRepoPath !== MEMORY
        ? { repo: activeRepoPath, path: activePath }
        : null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await flush();
    setTabs([...memTabs, ...splitTabs]);
    setSplitTabs(fileTabs);
    // The split remount flushes its old buffer; the main re-read is direct.
    if (toSplit && fileTabs.length) setSplit(toSplit);
    else setSplit(fileTabs.length ? fileTabs[fileTabs.length - 1] : null);
    await openFile(toMain.repo, toMain.path, false, true);
  }, [split, tabs, splitTabs, activeRepoPath, activePath, flush, openFile]);

  /**
   * The same document in both panes, on purpose. Not what a drag does — a
   * dragged tab moves — but a reader comparing Write against Source, or two
   * places in one long plan, wants two views of one file. The panes stay
   * honest with each other through the machinery that already exists: a save
   * in one is the other's outside edit, taken silently when clean and raised
   * as the conflict bar when both have typed.
   */
  const splitSame = useCallback(() => {
    if (!activeRepoPath || !activePath || activeRepoPath === MEMORY) return;
    openSplitFile(activeRepoPath, activePath);
  }, [activeRepoPath, activePath, openSplitFile]);

  /** The way back: a split tab dropped on the main strip moves across. */
  const moveToMain = useCallback(
    async (repo: string, path: string, at?: number) => {
      closeSplitTab(repo, path);
      setPaneFocus("main");
      await openFile(repo, path, false, true);
      if (at !== undefined) {
        setTabs((prev) => {
          const without = prev.filter((t) => !(t.repo === repo && t.path === path));
          const i = Math.max(0, Math.min(at, without.length));
          return [...without.slice(0, i), { repo, path }, ...without.slice(i)];
        });
      }
    },
    [closeSplitTab, openFile],
  );

  /*
   * Tabs drag, fluidly. Within a strip the list reorders live under the
   * pointer, the way browser tabs do. Across — onto the other strip, the
   * split drop zone, or the open split pane — the tab moves panes on
   * release: the strips are disjoint sets, so travel is a move, never a
   * copy. Pointer events throughout, for the same reason the tree's drag
   * uses them: nothing native can swallow them.
   */
  const tabPress = useRef<{
    strip: "main" | "split";
    repo: string;
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const tabCarried = useRef<typeof tabPress.current>(null);
  const tabDidDrag = useRef(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const splitTabsRef = useRef(splitTabs);
  splitTabsRef.current = splitTabs;

  /** Called from both strips' tabs; the strip name says which set it is. */
  const pressTab = useCallback(
    (strip: "main" | "split", repo: string, path: string, e: React.PointerEvent) => {
      if (e.button !== 0 || repo === MEMORY) return;
      tabPress.current = { strip, repo, path, x: e.clientX, y: e.clientY };
    },
    [],
  );

  /**
   * Right-click on a tab, in either strip: the pointing way to move a
   * document across, next to the close it pairs with.
   */
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    strip: "main" | "split";
    repo: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [tabMenu]);

  /** Swallow the click that follows a completed drag, in either strip. */
  const swallowTabClick = useCallback((e: React.MouseEvent) => {
    if (!tabDidDrag.current) return;
    tabDidDrag.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  useEffect(() => {
    /** The lit target, a class from here rather than CSS :hover — WKWebView
        does not reliably re-hover while a button is held. */
    let hot: HTMLElement | null = null;
    const setHot = (el: HTMLElement | null) => {
      if (hot === el) return;
      hot?.classList.remove("drop-hot");
      el?.classList.add("drop-hot");
      hot = el;
    };
    /** Insertion index in a strip from the pointer's x, by tab midpoints. */
    const indexIn = (strip: HTMLElement, x: number) => {
      const rects = [...strip.querySelectorAll<HTMLElement>(".tab")].map((el) =>
        el.getBoundingClientRect(),
      );
      let i = 0;
      for (const r of rects) if (x > r.left + r.width / 2) i += 1;
      return i;
    };
    const clear = () => {
      tabPress.current = null;
      tabCarried.current = null;
      setHot(null);
      document.body.classList.remove("tree-drag", "from-main", "from-split");
    };
    const move = (e: PointerEvent) => {
      const start = tabPress.current;
      if (!start) return;
      if (!tabCarried.current) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
        tabCarried.current = start;
        // Which side it came from decides which pane lights up as a target.
        document.body.classList.add(
          "tree-drag",
          start.strip === "split" ? "from-split" : "from-main",
        );
      }
      const it = tabCarried.current;
      const at = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
      const strip = at?.closest<HTMLElement>("[data-strip]");
      // Light whatever this tab could land on, as the pointer moves.
      if (strip && strip.dataset.strip !== it.strip) {
        setHot(strip);
      } else if (!strip && it.strip === "main") {
        setHot(at?.closest<HTMLElement>('[data-drop-pane="split"]') ?? null);
      } else if (!strip && it.strip === "split") {
        setHot(at?.closest<HTMLElement>(".main-pane") ?? null);
      } else {
        setHot(null);
      }
      if (!strip || strip.dataset.strip !== it.strip) return;
      // Home strip: reorder live. The set for the other strip changes only
      // on release, because moving a pane's open document mid-drag would
      // swap buffers under the pointer.
      const list = it.strip === "main" ? tabsRef.current : splitTabsRef.current;
      const from = list.findIndex((t) => t.repo === it.repo && t.path === it.path);
      if (from === -1) return;
      let to = indexIn(strip, e.clientX);
      // Dropping right of its own midpoint counts itself; settle on the slot.
      if (to > from) to -= 1;
      if (to === from) return;
      const next = list.slice();
      next.splice(to, 0, ...next.splice(from, 1));
      (it.strip === "main" ? setTabs : setSplitTabs)(next as typeof list);
    };
    const up = (e: PointerEvent) => {
      const it = tabCarried.current;
      if (!it) {
        tabPress.current = null;
        return;
      }
      tabDidDrag.current = true;
      const at = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
      const strip = at?.closest<HTMLElement>("[data-strip]");
      const pane = at?.closest<HTMLElement>('[data-drop-pane="split"]');
      clear();
      if (strip && strip.dataset.strip !== it.strip) {
        const i = indexIn(strip, e.clientX);
        if (it.strip === "main") void openInSplit(it.repo, it.path, i);
        else void moveToMain(it.repo, it.path, i);
      } else if (!strip && pane && it.strip === "main") {
        void openInSplit(it.repo, it.path);
      } else if (!strip && !pane && it.strip === "split") {
        // Released over the main pane's document: the tab comes across.
        const main = at?.closest<HTMLElement>(".main-pane");
        if (main) void moveToMain(it.repo, it.path);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && tabCarried.current) clear();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [openInSplit, moveToMain]);

  /**
   * Close everything.
   *
   * Pending edits are flushed first, as closing one tab does — the point is an
   * empty tab row, not a lost paragraph.
   */
  const closeAllTabs = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await flush();
    setTabs([]);
    setActivePath(null);
    setContent("");
    setMatter(null);
    setConflict(null);
    setMatterOpen(false);
  }, [flush]);

  /** Resolving a conflict: keep what you wrote, or take what arrived. */
  const resolveConflict = useCallback(
    async (choice: "mine" | "theirs") => {
      if (!activeRepoPath || !activePath) return;
      if (choice === "theirs") {
        pending.current = null;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        setConflict(null);
        setDirty(false);
        await openFile(activeRepoPath, activePath, false, true);
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

  /**
   * ⌘N and the palette. The sheet opens on the folder the last plan in this
   * repository was created in, as long as it still exists; with no memory it
   * falls back to beside whatever is open.
   */
  const lastPlanDir = useCallback(
    (repo: string): string | null => {
      const dir = localStorage.getItem(`plans.newPlanDir::${repo}`);
      if (dir === null) return null;
      return dir === "" || foldersIn(repo).includes(dir) ? dir : null;
    },
    [foldersIn],
  );

  /** The tokens every template is rendered against. */
  const vars = useCallback(
    (title: string) => ({
      title,
      // The first word of the configured vocabulary, which is what the plan
      // template already treats as "not started yet".
      firstStatus: statusChoices[0] ?? "draft",
    }),
    [statusChoices],
  );

  const makeFile = useCallback(
    async (repoPath: string, relPath: string, title: string, template: Template) => {
      setNaming(null);
      try {
        await api.createFile(repoPath, relPath, renderContent(template, vars(title)));
        track("plan_created", {
          bundled: BUNDLED.some(([f]) => f === template.file),
          prompted: template.prompt,
          inFolder: relPath.includes("/"),
        });
        // Where this landed is where the next one starts.
        localStorage.setItem(
          `plans.newPlanDir::${repoPath}`,
          relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
        );
        await refreshFiles();
        /*
         * Ask for the cursor, rather than placing it.
         *
         * `openFile` resolving means the state change was requested, not that
         * React has re-rendered and the editor has swapped its document — so a
         * `focus()` after this line lands in the file you were reading before,
         * which the swap then replaces. The editor honours the request once the
         * new document has settled.
         *
         * Only here, never in `openFile`: clicking through the tree to read
         * something and having the cursor land in it is how you type into a
         * document you meant to skim.
         */
        htmlBridge.focusNext = true;
        await openFile(repoPath, relPath);
        void refreshStatus();
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [refreshFiles, refreshStatus, openFile, notify, vars],
  );

  /**
   * Start a new file from a template, in a given repository and folder.
   *
   * A template that asks for a title puts the sheet up; one whose filename is
   * answered by the calendar alone skips it, which is what makes a daily note
   * a single keystroke. And a date-named file that is already there is today's
   * note rather than a collision, so it opens instead of refusing.
   */
  const newFromTemplate = useCallback(
    async (template: Template, repoPath: string, dir: string) => {
      if (template.prompt) {
        setNaming({ repo: repoPath, dir, template });
        return;
      }
      const name = renderName(template, vars(""));
      const relPath = dir ? `${dir}/${name}` : name;
      const there = await api.statPlan(repoPath, relPath).catch(() => "absent");
      if (there !== "absent") {
        void openFile(repoPath, relPath);
        return;
      }
      await makeFile(repoPath, relPath, "", template);
    },
    [vars, openFile, makeFile],
  );

  /** ⌘N and the palette: the chosen template, beside whatever is open. */
  const newHere = useCallback(
    (template: Template) => {
      if (!activeRepo) return;
      void newFromTemplate(
        template,
        activeRepo.path,
        lastPlanDir(activeRepo.path) ??
          (activePath?.includes("/") ? activePath.slice(0, activePath.lastIndexOf("/")) : ""),
      );
    },
    [activeRepo, activePath, lastPlanDir, newFromTemplate],
  );

  /** ⌘N alone: the first template, which is the shipped plan unless you moved it. */
  const newPlan = useCallback(() => {
    if (templates[0]) newHere(templates[0]);
  }, [templates, newHere]);

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

  const terminalOne = useCallback(
    (r: string) => void api.openInTerminal(r).catch((e) => notify(String(e), "error")),
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
   * Copy a file into another repository.
   *
   * The one file operation that is not a move. Within a repository, dragging a
   * plan somewhere else is a rename and git follows the history; between two
   * repositories there is no history to follow, so the destination gets an
   * addition and the original stays exactly where it was — which is also what
   * you want when the point is to take a plan's shape somewhere new.
   *
   * Flushed first, deliberately. The file being copied may be the buffer being
   * typed into, and the copy happens on disk: without this, what arrives in the
   * other repository is a few seconds old and nothing says so.
   */
  const copyTo = useCallback(
    async (fromRepo: string, from: string, toRepo: string, dir: string) => {
      await flush();
      const name = from.split("/").pop() ?? from;
      const to = dir ? `${dir}/${name}` : name;
      fileAction(toRepo, "Copied", async () => {
        await api.copyPlan(fromRepo, from, toRepo, to);
        // Before opening it: the tree is what the open path is checked against.
        await refreshFiles();
        // Nothing about the tabs changes. Unlike a move, every open buffer is
        // still pointing at a file that is still there.
        await openFile(toRepo, to);
      });
    },
    [flush, fileAction, refreshFiles, openFile],
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

      track("plan_moved", { toDone: inDoneFolder(to), fromDone: inDoneFolder(from), toRoot: !dir });
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

  /**
   * New file in a given folder, rather than beside whatever is open. The tree
   * names the template it wants by filename; an unknown one falls back to the
   * first, which is what the menu shows when there is only one to show.
   */
  const newFileIn = useCallback(
    (repoPath: string, dir: string, templateFile?: string) => {
      const t = templates.find((x) => x.file === templateFile) ?? templates[0];
      if (t) void newFromTemplate(t, repoPath, dir);
    },
    [templates, newFromTemplate],
  );


  const onRun = useCallback(
    (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      // "On <branch>" carries a name; every other label is a word of ours.
      const command = label.startsWith("On ") ? "branch" : label.toLowerCase();
      fn()
        .then(() => {
          notify(label);
          track("git_command_run", { command, ok: true });
        })
        .catch((e) => {
          notify(String(e), "error");
          track("git_command_run", { command, ok: false });
        })
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
    return [
      { id: "git.pull", label: "Pull", hint: "--ff-only", run: () => onRun("Pulled", () => api.gitPull(repo)) },
      { id: "git.push", label: "Push", run: () => onRun("Pushed", () => api.gitPush(repo)) },
      { id: "git.fetch", label: "Fetch", hint: "--prune", run: () => onRun("Fetched", () => api.gitFetch(repo)) },
      {
        id: "git.branches.refresh",
        label: "Refresh branches",
        hint: "re-read the list from git",
        run: () =>
          void api
            .gitBranches(repo)
            .then((b) => {
              setBranches(b.branches);
              notify("Branches refreshed");
            })
            .catch((e: unknown) => notify(String(e), "error")),
      },
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
        label: "Stage every changed file",
        run: () =>
          onRun("Staged", () =>
            api.gitStage(repo, entries.filter((e) => e.worktree !== " ").map((e) => e.path)),
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
  }, [activeRepo, branches, status, onRun, notify]);

  // --- keys ----------------------------------------------------------------
  // Whether keystrokes go to the document or to the app, held as state rather
  // than probed from activeElement on every keydown. focusin/focusout bubble
  // from every editable surface; on focusout the target that matters is where
  // focus went, which is relatedTarget (null when focus leaves entirely).
  const [editing, setEditing] = useState(false);
  /** The shortcut sheet (⌘/) — the registry, drawn. */
  const [shortcuts, setShortcuts] = useState(false);

  /*
   * ⌘F: one find bar, owned here where the views are switched, with a
   * per-surface match engine underneath — the same shape as the buffer
   * itself, which is App's while the surfaces render it. Null is closed; the
   * query survives view switches because it lives here, not in any engine.
   * `focusSeq` is bumped when the bar should take the keyboard, and left
   * alone when ⌘F came from the chat composer — find opens over the
   * document, but must not steal a half-written message's cursor.
   */
  const [find, setFind] = useState<{ query: string; focusSeq: number } | null>(null);
  const [findCount, setFindCount] = useState<{ current: number; total: number } | null>(null);
  /** Where focus was when the bar opened, so Escape can hand it back. */
  const findReturn = useRef<HTMLElement | null>(null);
  /** The engines: each surface registers one while mounted. */
  const mainWriteFind = useRef<FindHandle | null>(null);
  /** The main write surface's selection, registered the same way. */
  const mainWriteSelection = useRef<(() => string) | null>(null);
  /** The main write surface's whole document, for copying a workspace out. */
  const mainWriteMarkdown = useRef<(() => string | null) | null>(null);
  const mainSourceFind = useRef<FindHandle | null>(null);
  const splitFind = useRef<FindHandle | null>(null);
  /** The engine last driven, so switching surfaces clears the old paint. */
  const findLast = useRef<FindHandle | null>(null);
  /** A palette hit's line, waiting to pick the nearest match once set runs. */
  const findSeed = useRef<{ line: number } | null>(null);

  /**
   * The focused pane's engine — `paneFocus` answers the same question for
   * save. Null over a diff: a read-only view of a transient comparison gets
   * nothing, deliberately, so ⌘F there does nothing rather than half-works.
   */
  const findEngine = useCallback(() => {
    const r = paneRoute.current;
    if (r.split && r.paneFocus === "split") return splitFind.current;
    const v = viewNow.current;
    if (v === "diff") return null;
    if (v === "write" && (r.activeRepoPath === MEMORY || isMarkdownPath(r.activePath ?? "")))
      return mainWriteFind.current;
    return mainSourceFind.current;
  }, []);

  const reportFind = useCallback(
    (current: number, total: number) => setFindCount({ current, total }),
    [],
  );

  const closeFind = useCallback(() => {
    setFind(null);
    const el = findReturn.current;
    findReturn.current = null;
    // The same "back out" contract Escape already keeps: focus returns to
    // where the cursor was, if that place still exists.
    if (el && el.isConnected) el.focus();
  }, []);

  const openFind = useCallback(() => {
    if (!paneRoute.current.activePath) return;
    if (!findEngine()) return; // a diff — find is not offered there
    const target = document.activeElement as HTMLElement | null;
    const fromComposer = !!target?.closest(".chat");
    if (!fromComposer) findReturn.current = target;
    track("find_opened", { fromComposer });
    setFind((f) => ({
      query: f?.query ?? "",
      focusSeq: fromComposer ? (f?.focusSeq ?? 0) : (f?.focusSeq ?? 0) + 1,
    }));
  }, [findEngine]);

  /** Runs the pending engine update now — Enter must not chase a stale query. */
  const flushFind = useRef<() => void>(() => {});
  useEffect(() => {
    if (!find) {
      findLast.current?.clear();
      findLast.current = null;
      setFindCount(null);
      flushFind.current = () => {};
      return;
    }
    let timer: number | null = null;
    const apply = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const eng = findEngine();
      if (findLast.current && findLast.current !== eng) findLast.current.clear();
      findLast.current = eng;
      const seed = findSeed.current;
      findSeed.current = null;
      eng?.set(
        find.query,
        seed && find.query ? nearestMatchIndex(sourceNow.current, find.query, seed.line) : undefined,
      );
    };
    flushFind.current = apply;
    // Debounced like the buffer's own 180ms report: highlight-all on a large
    // plan is the perf risk, and it should not run on every keystroke.
    timer = window.setTimeout(apply, 180);
    return () => {
      if (timer) clearTimeout(timer);
    };
    // Re-targeted whenever the focused surface changes identity, so the
    // query carries across a write/source switch and across panes.
  }, [find, view, paneFocus, split, activePath, docKey, findEngine]);
  /** The defaults, the chosen pack, then the reader's overrides on top. */
  const keymap = useMemo(
    () => mergeKeys(settings.keyOverrides, settings.keyPreset),
    [settings.keyOverrides, settings.keyPreset],
  );

  /**
   * A half-typed chord: the armed prefix, waiting `CHORD_MS` for its second
   * combo. A ref for the keydown handler, a state twin for the status bar —
   * a half-typed chord must be visible or it reads as dropped keystrokes.
   */
  const pendingChord = useRef<string | null>(null);
  const chordTimer = useRef<number | null>(null);
  const [chordHint, setChordHint] = useState<string | null>(null);
  const clearChord = useCallback(() => {
    pendingChord.current = null;
    if (chordTimer.current) clearTimeout(chordTimer.current);
    chordTimer.current = null;
    setChordHint(null);
  }, []);


  /** ⌘\ — open the most recent other buffer beside this one, or close the split. */
  const toggleSplit = useCallback(() => {
    if (split) {
      setSplit(null);
      return;
    }
    const other = [...tabs]
      .reverse()
      .find(
        (t) =>
          t.repo !== MEMORY && !(t.repo === activeRepoPath && t.path === activePath),
      );
    if (!other) {
      notify("Nothing else open — the split shows another buffer beside this one");
      return;
    }
    openSplitFile(other.repo, other.path);
  }, [split, tabs, activeRepoPath, activePath, notify, openSplitFile]);


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

      // ⌘P plans, ⌘⇧P commands. The ">" is what actually picks the mode, so
      // these are two doors into the same box. ⌘K used to be a third; it is
      // now the chord prefix, matched from the registry below.
      if (mod && !e.ctrlKey && e.key.toLowerCase() === "p") {
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
      /*
       * The registry: every unconditional binding, matched against the merged
       * keymap rather than spelled out again here. What remains hand-written
       * below is exactly the keys whose meaning depends on what is on screen.
       */
      const runs: Record<string, () => void> = {
        save: () => {
          // The focused pane's document, not always the main one.
          if (paneFocus === "split" && splitFlush.current) {
            void splitFlush.current();
            return;
          }
          if (saveTimer.current) clearTimeout(saveTimer.current);
          void flush();
        },
        new: newPlan,
        find: openFind,
        // The convention every app that comments uses.
        comment: () => {
          if (view === "write" && activePath) newComment();
        },
        rename: () => {
          if (activeRepoPath && activePath && activeRepoPath !== MEMORY) {
            renameFile(activeRepoPath, activePath);
          }
        },
        "repo.add": () => void addRepo(),
        "v.write": () => goto("write"),
        "v.source": () => goto("source"),
        "v.settings": () => {
          setKeyboardOpen(false);
          setSettingsOpen((o) => !o);
        },
        zen: () => setZen((z) => !z),
        // Closes the buffer, not the window — there is only ever one window.
        // With two panes, the focused split closes first: the pane, then buffers.
        "tab.close": () => {
          if (paneFocus === "split" && split) {
            closeSplitTab(split.repo, split.path);
            return;
          }
          if (activeRepoPath && activePath) void closeTab(activeRepoPath, activePath);
        },
        /*
         * ⌃Tab, the binding every tabbed application has, plus the ⌘⌥ arrows.
         * Kept off ⌃T, which is transpose-characters in every macOS text
         * field including this app's own.
         */
        "tab.next": () => cycleTab(1),
        "tab.prev": () => cycleTab(-1),
        "tab.next2": () => cycleTab(1),
        "tab.prev2": () => cycleTab(-1),
        "tab.closeAll": () => void closeAllTabs(),
        showMux: () => showPanel("showMux"),
        showGit: () => showPanel("showGit"),
        showAllFiles: () => set({ showAllFiles: !settings.showAllFiles }),
        shortcuts: () => setShortcuts((v) => !v),
        split: toggleSplit,
        "split.dir": () => setSplitDir((d) => (d === "row" ? "column" : "row")),
        "pane.1": () => setPaneFocus("main"),
        "pane.2": () => {
          if (split) setPaneFocus("split");
        },
        // The keys for what used to be ⌥-click only: pin the focused pane.
        "v.write.pane": () => goto("write", true),
        "v.source.pane": () => goto("source", true),
        "v.keyboard": () => {
          setSettingsOpen(true);
          setKeyboardOpen(true);
        },
      };
      /*
       * A chord is half-typed: the next combo either completes one, or the
       * armed state clears and the keystroke is processed normally. Bare
       * modifiers keep waiting — they are how the second combo is reached.
       */
      if (pendingChord.current) {
        if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
        const pending = pendingChord.current;
        clearChord();
        for (const entry of keymap) {
          if (!matchKeys(e, entry.keys, pending)) continue;
          e.preventDefault();
          runs[entry.id]?.();
          return;
        }
      }
      for (const entry of keymap) {
        if (!matchKeys(e, entry.keys)) continue;
        // A chord an editor already used is not also an app chord: ⌘/ is
        // toggle-comment wherever CodeMirror holds the caret, and the event
        // arrives here already defaultPrevented. Opening the sheet on top of
        // the comment made one keystroke do two things.
        if (e.defaultPrevented) return;
        e.preventDefault();
        runs[entry.id]?.();
        return;
      }
      /*
       * The first combo of any bound chord: swallow it, arm the pending
       * state, and give the second combo `CHORD_MS` to arrive. Still the one
       * lookup — a chord is a spec with a space, not a second dispatch path.
       */
      for (const entry of keymap) {
        const prefix = matchChordPrefix(e, entry.keys);
        if (!prefix) continue;
        if (e.defaultPrevented) return;
        e.preventDefault();
        pendingChord.current = prefix;
        setChordHint(prefix);
        if (chordTimer.current) clearTimeout(chordTimer.current);
        chordTimer.current = window.setTimeout(clearChord, CHORD_MS);
        return;
      }
      if (mod && e.key.toLowerCase() === "b") {
        /**
         * ⌘B is the convention for the sidebar, but inside the page it has to
         * stay bold — so it goes to whichever is in front: the editor keeps it
         * while you are writing, the sidebar gets it everywhere else. ⌘⌃B
         * always toggles, for when the caret is in the page and you want it.
         */
        if (editing && !e.ctrlKey) return;
        e.preventDefault();
        set({ showIndex: !settings.showIndex });
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
      } else if (e.key === "Escape" && editing) {
        // Hand focus back to the app. In zen there is no tab row, so this
        // blurs only — a second Esc then leaves zen via the branch below.
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        document.querySelector<HTMLElement>(".tab.on .tab-name")?.focus();
      } else if (e.key === "Escape" && zen) {
        setZen(false);
      } else if (e.key === "Escape" && settingsOpen) {
        // The Keyboard page backs out to Settings first, then Settings closes.
        if (keyboardOpen) setKeyboardOpen(false);
        else setSettingsOpen(false);
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
    keyboardOpen,
    keymap,
    clearChord,
    closeAllTabs,
    cycleTab,
    paneFocus,
    split,
    toggleSplit,
    closeSplitTab,
    openFind,
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
      shownRepos.flatMap((r) =>
        (filesByRepo[r.path] ?? []).map((file) => ({
          repoPath: r.path,
          repoName: r.name,
          file,
        })),
      ),
    [shownRepos, filesByRepo],
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

  // The one bar, rendered into whichever pane has focus so the highlight
  // never appears somewhere you are not looking.
  const findBar = find ? (
    <FindBar
      query={find.query}
      focusSeq={find.focusSeq}
      count={findCount}
      onQuery={(q) => setFind((f) => (f ? { ...f, query: q } : f))}
      onNext={() => {
        flushFind.current();
        findEngine()?.next();
      }}
      onPrev={() => {
        flushFind.current();
        findEngine()?.prev();
      }}
      onClose={closeFind}
    />
  ) : null;
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
        <button
          className={`rail-btn ${treeOpen ? "on" : ""}`}
          onClick={() => set({ showIndex: !settings.showIndex })}
          title="File tree (⌘B)"
          aria-pressed={treeOpen}
        >
          Files
        </button>
        {/* Who you are to the workspace server; signed out reads as an
            invitation. Sign-out is behind a confirm, since it closes rooms. */}
        {account ? (
          <button
            className="rail-btn account"
            onClick={() => void signOut()}
            title={`Signed in to workspaces as ${account.login} — click to sign out`}
            data-testid="account"
          >
            {account.name ?? account.login}
          </button>
        ) : (
          <button
            className="rail-btn"
            onClick={() => setSigningIn(true)}
            title="Sign in, for workspaces"
            data-testid="sign-in"
          >
            Sign in
          </button>
        )}
        <span className="rail-sep" data-tauri-drag-region />
        <span className="wordmark" data-tauri-drag-region>
          Looped Plans
        </span>

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
                { value: "__add", label: "Add a repository…", apart: true, always: true },
              ]}
            />
            {activeRepo && (
              <Dropdown
                className="branch-pick"
                ariaLabel="Branch"
                onOpen={() => setWantBranches(true)}
                value={branch}
                disabled={!!busy}
                status={branchesLoading ? "Refreshing…" : undefined}
                onChange={(b) =>
                  onRun(`Switched to ${b}`, () => api.gitCheckout(activeRepo.path, b))
                }
                choices={[
                  ...(branches.length ? branches : [branch]).map((b) => ({
                    value: b,
                    label: b,
                  })),
                  // On origin and not here yet: picking one is a checkout that
                  // creates the tracking branch, which is why it can sit in
                  // the same menu rather than in a second one.
                  ...remoteBranches.map((b) => ({
                    value: b,
                    label: b.split("/").slice(1).join("/"),
                    note: b.split("/")[0],
                    apart: true,
                  })),
                ]}
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
          /* One switch, one state, both panes — and ⌥-click pins only the
             focused pane, so one file can sit rich on one side and raw on
             the other. The highlight follows the focused pane. */
          <span className="segmented small view-switch">
            {/* Write is a markdown surface: for anything else it is hidden,
                not disabled — the buffer has one honest mode, Source. */}
            {isMarkdownPath(paneFocus === "split" && split ? split.path : activePath) && (
              <button
                className={(paneFocus === "split" && split ? (splitOverride ?? view) : view) === "write" ? "on" : ""}
                onClick={(e) => goto("write", e.altKey)}
                title="⌥-click: this pane only"
              >
                Write
              </button>
            )}
            <button
              className={(paneFocus === "split" && split ? (splitOverride ?? view) : view) === "source" ? "on" : ""}
              onClick={(e) => goto("source", e.altKey)}
              title="The raw markdown, exactly as it is on disk — ⌥-click: this pane only"
            >
              Source
            </button>
            {/* Diff is not a mode you switch into: it belongs to changed
                files, reached from the git panel — and shown here only while
                the buffer is actually in it, so there is a way to read the
                state and a way back out. */}
            {(paneFocus === "split" && split ? (splitOverride ?? view) : view) === "diff" && (
              <button className="on" title="Live diff against the last commit">
                Diff
              </button>
            )}
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
            title={
              runningCount
                ? `Agent chat (⌘J) — ${runningCount} running`
                : "Agent chat (⌘J)"
            }
            aria-pressed={muxOpen}
          >
            Chat
            {/* Across every repository, not only the open one. What this
                number is about is `node` processes on the machine, and a badge
                that hid the ones running in a repo you switched away from
                would be hiding exactly what it exists to report. */}
            {runningCount > 0 && <span className="count live">{runningCount}</span>}
          </button>
        )}
        <button
          className={`rail-btn ${settingsOpen ? "on" : ""}`}
          onClick={() => {
            setKeyboardOpen(false);
            setSettingsOpen((o) => !o);
          }}
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
              repos={shownRepos}
              filesByRepo={shownByRepo}
              marks={liveMarks}
              activeRepoPath={settingsOpen ? null : activeRepoPath}
              activePath={activePath}
              expanded={expanded}
              onToggle={toggleNode}
              onOpen={openOne}
              onForgetRepo={forgetRepo}
              onRenameRepo={renameRepo}
              onReorderRepo={reorderRepo}
              filter={filter}
              showExtensions={settings.showExtensions}
              statusOrder={statusOrder}
              onStage={stageOne}
              onUnstage={unstageOne}
              onDiscard={discardOne}
              onDelete={deleteOne}
              onDeleteDir={deleteDirOne}
              onReveal={revealOne}
              onTerminal={terminalOne}
              onOpenSplit={openInSplit}
              onHandOff={chat === false ? undefined : (repo, path, kind) => void handOff(kind, repo, path)}
              onNewFile={newFileIn}
              templates={templates}
              onNewFolder={newFolderIn}
              onMove={moveTo}
              onCopy={(from, path, toRepo, dir) => void copyTo(from, path, toRepo, dir)}
              emptyDirs={treeDirs}
              onRename={renameFile}
              onMoveTo={(repo, path) => setMoving({ repo, path })}
              onSetOpen={setOpen}
            />
          </div>

          {workspacesConfigured() && (
            <Workspaces
              account={account}
              workspaces={workspaces}
              activeId={settingsOpen ? null : wsIdOf(activePath)}
              live={new Set([...rooms.current].filter(([, r]) => r.status === "open").map(([id]) => id))}
              onOpen={(ws) => void openWorkspace(ws)}
              onNew={() => setWsNaming(true)}
              onSignIn={() => setSigningIn(true)}
            />
          )}

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
          {settingsOpen && keyboardOpen ? (
            <KeyboardPage settings={settings} onChange={set} onBack={() => setKeyboardOpen(false)} />
          ) : settingsOpen ? (
            <SettingsPage
              settings={settings}
              onChange={set}
              onReset={() => setSettings(DEFAULTS)}
              repos={shownRepos}
              activeRepoPath={activeRepoPath}
              onAddRepo={addRepo}
              onForgetRepo={forgetRepo}
              onInstallSkill={(path) =>
                void installConventions(path, agentPaths.current)
                  .then(
                    (r) => {
                      track("skill_installed", { result: r });
                      notify(
                        r === "current"
                          ? "Conventions already up to date"
                          : r === "installed"
                            ? "Conventions installed"
                            : "Conventions updated — review them in the git panel",
                      );
                    },
                    (e: unknown) => notify(String(e), "error"),
                  )
                  .finally(() => void readInstalls())
              }
              skills={skills}
              onInstallCli={installCli}
              onInstallAgent={(id) =>
                void api.agentInstall(id).then(
                  (pkg) => {
                    notify(`Installed ${pkg}`);
                    void readInstalls();
                  },
                  (e) => notify(String(e), "error"),
                )
              }
              cli={cli}
              agents={agents}
              version={appVersion}
              onCheckUpdates={() => void lookForUpdate(true)}
              onReleaseNotes={() => void showNotes()}
              onKeyboard={() => setKeyboardOpen(true)}
              settingsFilePath={settingsPath}
              onOpenSettingsFile={openSettingsFile}
              templates={templates}
              templatesDir={templatesDir}
              onOpenTemplates={() =>
                void api.templatesOpen().catch((e) => notify(String(e), "error"))
              }
            />
          ) : (
            <>
              {/* The document area: two pane columns, each carrying its own
                  strip, header and buffer — the chrome resizes with the
                  document it describes. Zen collapses to the main one. */}
              <div className={`page-body ${splitDir === "column" ? "dir-col" : "dir-row"}`}>
              <div
                className="main-pane"
                style={split && !zen ? { flex: `${splitRatio} 1 0px` } : undefined}
                onMouseDownCapture={() => setPaneFocus("main")}
                onFocusCapture={() => setPaneFocus("main")}
              >
              {/* Zen is one buffer and nothing else — no tabs, no header. */}
              {tabs.length > 0 && !zenOn && (
                <div className="tab-row">
                <div
                  className="tabs"
                  data-strip="main"
                  role="tablist"
                  onClickCapture={swallowTabClick}
                >
                  {tabs.map((t) => {
                    const on = t.repo === activeRepoPath && t.path === activePath;
                    const mark = liveMarks.get(`${t.repo}::${t.path}`) ?? "clean";
                    const name = wsIdOf(t.path)
                      ? (workspaces.find((w) => w.id === wsIdOf(t.path))?.name ?? "Workspace")
                      : (t.path.split("/").pop() ?? t.path);
                    // Changed on disk since we read it. Says so rather than
                    // acting: opening the tab re-reads the file anyway.
                    const moved = outside.has(`${t.repo}::${t.path}`);
                    return (
                      <span
                        className={`tab ${on ? "on" : ""}${
                          on && editing && paneFocus === "main" ? " editing" : ""
                        } ${mark}${moved ? " outside" : ""}`}
                        key={`${t.repo}::${t.path}`}
                      >
                        <button
                          className="tab-name"
                          role="tab"
                          aria-selected={on}
                          title={moved ? `${t.path} — changed on disk` : t.path}
                          onClick={() =>
                            void (t.repo === MEMORY
                              ? openMemory(t.path, memoryDocs.current.get(t.path) ?? "")
                              : openFile(t.repo, t.path))
                          }
                          onAuxClick={(e) => {
                            if (e.button === 1) void closeTab(t.repo, t.path);
                          }}
                          onPointerDown={(e) => pressTab("main", t.repo, t.path, e)}
                          onContextMenu={(e) => {
                            if (t.repo === MEMORY) return;
                            e.preventDefault();
                            setTabMenu({
                              x: e.clientX,
                              y: e.clientY,
                              strip: "main",
                              repo: t.repo,
                              path: t.path,
                            });
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
                <span className="page-path">
                  {wsIdOf(activePath)
                    ? `workspace · ${workspaces.find((w) => w.id === wsIdOf(activePath))?.name ?? ""}`
                    : (activePath ?? "")}
                </span>
                {activePath && (
                  <span className="page-actions">
                    {/* A workspace's chrome: where the review stands, the
                        moves available to this person, and the way out. The
                        author rule is the server's; the buttons only avoid
                        offering what it will refuse. */}
                    {wsIdOf(activePath) &&
                      (() => {
                        const id = wsIdOf(activePath)!;
                        const ws = workspaces.find((w) => w.id === id);
                        const room = rooms.current.get(id);
                        if (!ws) return null;
                        const r = ws.review;
                        const mine = r.requestedBy === account?.login;
                        return (
                          <>
                            {room && room.status !== "open" && (
                              <span className="ws-status" title="Reconnecting to the workspace server">
                                {room.status === "connecting" ? "connecting…" : "offline"}
                              </span>
                            )}
                            {r.state !== "none" && (
                              <span
                                className={`status-badge tone-${reviewTone(r.state)}`}
                                title={
                                  r.state === "requested"
                                    ? `Review requested by ${r.requestedBy}`
                                    : `${reviewLabel(r.state)} by ${r.decidedBy}`
                                }
                                data-testid="review-state"
                              >
                                {reviewLabel(r.state)}
                              </span>
                            )}
                            {r.state === "none" || r.state === "changes" ? (
                              <button className="rail-btn" onClick={() => void reviewAct(id, "request")}>
                                Request review
                              </button>
                            ) : r.state === "requested" ? (
                              <>
                                <button
                                  className="rail-btn"
                                  onClick={() => void reviewAct(id, "approve")}
                                  disabled={mine}
                                  title={mine ? "You asked for this review; someone else approves it" : "Approve this plan"}
                                >
                                  Approve
                                </button>
                                <button
                                  className="rail-btn"
                                  onClick={() => void reviewAct(id, "changes")}
                                  disabled={mine}
                                  title={mine ? "You asked for this review" : "Send it back"}
                                >
                                  Request changes
                                </button>
                              </>
                            ) : null}
                            {/* Sharing sits next to review: "look at this" in
                                two strengths, one for members and one for
                                anyone holding the link. */}
                            <button
                              className="rail-btn"
                              onClick={() => setWsSharing(id)}
                              title="A read-only link for someone with no account"
                            >
                              Share…
                            </button>
                            <button
                              className="rail-btn"
                              onClick={() => setWsInviting(id)}
                              title={`Members: ${ws.members.join(", ")}`}
                            >
                              Invite
                            </button>
                            {shownRepos.length > 0 && (
                              <button
                                className="rail-btn"
                                onClick={() =>
                                  setWsCopying({
                                    id,
                                    repo: activeRepo?.path ?? shownRepos[0].path,
                                    dir: lastPlanDir(activeRepo?.path ?? shownRepos[0].path) ?? "",
                                  })
                                }
                                title="Write this document into a repository as a file"
                              >
                                Copy to repository…
                              </button>
                            )}
                          </>
                        );
                      })()}
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

              {(!split || paneFocus === "main") && findBar}

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
                  {/* Not mounted at all for a non-markdown file: even parked
                      aside, Milkdown would parse the text as markdown, and
                      that document must never exist for a file it could
                      rewrite. Memory buffers are the app's own prose. */}
                  {(activeRepoPath === MEMORY || isMarkdownPath(activePath)) && (
                  <div
                    className={`surface ${view === "write" ? "" : "aside"}`}
                    onContextMenu={(e) => {
                      if (view !== "write") return;
                      e.preventDefault();
                      setPageMenu({
                        x: e.clientX,
                        y: e.clientY,
                        selection: mainWriteSelection.current?.() ?? "",
                      });
                    }}
                  >
                    <Editor
                      /* A workspace is its own editor: the collab plugin is
                         bound at construction, and a different room is a
                         different document rather than a swap. */
                      key={wsIdOf(activePath) ?? "file"}
                      room={wsIdOf(activePath) ? rooms.current.get(wsIdOf(activePath)!) : undefined}
                      markdownRef={mainWriteMarkdown}
                      docKey={docKey}
                      repo={activeRepo?.path ?? ""}
                      relPath={activePath}
                      initialValue={content}
                      spellcheck={settings.spellcheck}
                      imageFolder={settings.imageFolder}
                      author={author}
                      onChange={onChange}
                      onOpenLink={(href) =>
                        activeRepoPath &&
                        activePath &&
                        followLink(activeRepoPath, activePath, href)
                      }
                      findRef={mainWriteFind}
                      selectionRef={mainWriteSelection}
                      onFindCount={reportFind}
                    />
                  </div>
                  )}
                  <div className={`surface ${view === "source" ? "" : "aside"}`}>
                    <SourceView
                      value={source}
                      onChange={onSourceChange}
                      settings={settings}
                      docKey={docKey}
                      active={view === "source"}
                      findRef={mainSourceFind}
                      onFindCount={reportFind}
                    />
                  </div>
                </>
              ) : (
                <div className="editor-host">
                  {/* Keyed by file: every piece of diff state — committed
                      side, disk copy, settled buffer — must belong to one
                      document, or a click on the next changed file diffs one
                      file's head against another's text for a beat. */}
                  <DiffView
                    key={`${activeRepoOrPath}::${activePath}`}
                    repo={activeRepoOrPath}
                    relPath={activePath}
                    buffer={source}
                    onEdit={onSourceChange}
                    settings={settings}
                    epoch={epoch}
                  />
                </div>
              )}
              </div>
              {/* Where a dragged file lands to open beside this one. Inert
                  except while a drag is live (body.tree-drag) — and gone once
                  a split exists: the open pane is the target then, and a
                  strip over its far edge would promise a third pane this app
                  deliberately does not have. */}
              {!zen && activePath && !split && (
                <div className="split-drop" data-drop-pane="split" aria-hidden>
                  <span className="split-drop-hint">Open beside</span>
                </div>
              )}
              {split && !zen && (
                <>
                  <div
                    className="pane-divider"
                    role="separator"
                    aria-orientation={splitDir === "row" ? "vertical" : "horizontal"}
                    aria-label="Resize the split"
                    title="Drag to resize · double-click to even out"
                    onDoubleClick={() => setSplitRatio(0.5)}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const rect = (
                        e.currentTarget as HTMLElement
                      ).parentElement!.getBoundingClientRect();
                      const move = (ev: PointerEvent) => {
                        const frac =
                          splitDir === "row"
                            ? (ev.clientX - rect.left) / rect.width
                            : (ev.clientY - rect.top) / rect.height;
                        setSplitRatio(Math.min(0.85, Math.max(0.15, frac)));
                      };
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                  />
                  <div className="split-host" data-drop-pane="split" style={{ flex: `${1 - splitRatio} 1 0px` }}>
                    <SplitPane
                      key={`${split.repo}::${split.path}`}
                      repo={split.repo}
                      relPath={split.path}
                      settings={settings}
                      author={author}
                      view={
                        // The split obeys the same rule as the main pane:
                        // Write only ever holds markdown.
                        (splitOverride ?? view) === "write" && !isMarkdownPath(split.path)
                          ? "source"
                          : (splitOverride ?? view)
                      }
                      epoch={epoch}
                      canDiff={repos.some((r) => r.path === split.repo)}
                      tabs={splitTabs}
                      onSelectTab={openSplitFile}
                      onCloseTab={closeSplitTab}
                      editing={editing && paneFocus === "split"}
                      onTabPress={(r, pt, e) => pressTab("split", r, pt, e)}
                      onTabMenu={(r, pt, e) => {
                        e.preventDefault();
                        setTabMenu({
                          x: e.clientX,
                          y: e.clientY,
                          strip: "split",
                          repo: r,
                          path: pt,
                        });
                      }}
                      onStripClickCapture={swallowTabClick}
                      focused={paneFocus === "split"}
                      onFocus={() => setPaneFocus("split")}
                      onClose={() => setSplit(null)}
                      notify={notify}
                      flushRef={splitFlush}
                      onOpenLink={(href) => followLink(split.repo, split.path, href)}
                      liveText={
                        split.repo === activeRepoPath && split.path === activePath
                          ? source
                          : null
                      }
                      onLiveEdit={adoptFromSplit}
                      findRef={splitFind}
                      onFindCount={reportFind}
                      findBar={paneFocus === "split" ? findBar : null}
                    />
                  </div>
                </>
              )}
              </div>
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
              void openFile(repo, p, false, false, "diff");
            }}
          />
        )}

        {muxOpen && (
          <ChatPanel
            running={running}
            repo={activeRepoPath!}
            relPath={activePath}
            seed={chatSeed}
            onSeedUsed={() => setChatSeed(null)}
            cmd={settings.chatCommand}
            notify={notify}
            onResize={startChatResize}
            chats={chats}
            onNewChat={newChat}
            onOpenChat={openChat}
            onDeleteChat={(id) => void deleteChat(id)}
            onRenameChat={renameChat}
            onTitle={nameChat}
            authHint={agents.find((a) => a.id === settings.chatCommand)?.auth ?? ""}
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
          {/* The armed chord prefix — visible, or it reads as dropped keys. */}
          {chordHint && <span className="chord-hint">{renderKeys(chordHint)} …</span>}
          <span className="bar-spacer" />
          {activeRepoPath && usage[`${activeRepoPath}::${chats.current}`] && (
            <span title="The agent's context window, and what this session has cost">
              <b>
                {Math.round(
                  (usage[`${activeRepoPath}::${chats.current}`].used / Math.max(1, usage[`${activeRepoPath}::${chats.current}`].size)) * 100,
                )}
                %
              </b>{" "}
              context
              {usage[`${activeRepoPath}::${chats.current}`].cost ? ` · $${usage[`${activeRepoPath}::${chats.current}`].cost!.toFixed(2)}` : ""}
            </span>
          )}
          {busy && <span className="saving">{busy}…</span>}
          {changeCount > 0 && (
            <span>
              <b>{changeCount}</b> uncommitted
            </span>
          )}
          <span>⌘G git · ⌘, settings</span>
        </footer>
      )}

      {pageMenu && (
        <div
          className="ctx"
          style={{ left: pageMenu.x, top: pageMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="ctx-item"
            onClick={() => {
              setPageMenu(null);
              newComment();
            }}
          >
            New comment…
          </button>
          {/* Only with something selected, and only where there is an agent
              to send it to: a menu item that scolds you for not selecting
              first is worse than one that is absent. */}
          {pageMenu.selection.trim() !== "" && chat !== false && activeRepoPath !== MEMORY && (
            <button
              className="ctx-item"
              onClick={() => {
                const selection = pageMenu.selection;
                setPageMenu(null);
                rewriteSelection(selection);
              }}
            >
              Rewrite…
            </button>
          )}
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
          allowEmpty={asking.allowEmpty}
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

      {signingIn && (
        <SignInSheet
          onCancel={() => setSigningIn(false)}
          onDone={(who) => {
            setSigningIn(false);
            setAccount(who);
            track("sign_in_completed");
            void refreshWorkspaces();
            notify(`Signed in as ${who.login}`);
          }}
        />
      )}

      {wsNaming && (
        <TextPrompt
          title="New workspace"
          placeholder="What is being argued"
          note="A room with you in it. Invite others from its page."
          confirm="Create"
          onCancel={() => setWsNaming(false)}
          onSubmit={(name) => void makeWorkspace(name)}
        />
      )}

      {wsInviting && (
        <TextPrompt
          title="Invite to this workspace"
          placeholder="Email address"
          note="They see it the next time they sign in."
          confirm="Invite"
          onCancel={() => setWsInviting(null)}
          onSubmit={(login) => void inviteTo(wsInviting, login)}
        />
      )}

      {wsSharing && (
        <ShareSheet
          id={wsSharing}
          name={workspaces.find((w) => w.id === wsSharing)?.name ?? "this document"}
          notify={notify}
          onClose={() => setWsSharing(null)}
        />
      )}

      {wsCopying && (
        <NameSheet
          label="Copy to repository"
          confirm="Copy"
          initial={workspaces.find((w) => w.id === wsCopying.id)?.name ?? ""}
          nameOf={(title) => `${slugOf(title)}.md`}
          dir={wsCopying.dir}
          repo={wsCopying.repo}
          repos={shownRepos}
          onRepoChange={(repo) => setWsCopying({ ...wsCopying, repo, dir: lastPlanDir(repo) ?? "" })}
          dirs={(() => {
            const seen = new Set<string>(treeDirs[wsCopying.repo] ?? []);
            for (const f of filesByRepo[wsCopying.repo] ?? []) if (f.dir) seen.add(f.dir);
            return [...seen].sort();
          })()}
          onDirChange={(dir) => setWsCopying({ ...wsCopying, dir })}
          onCancel={() => setWsCopying(null)}
          onCreate={(relPath) => void copyWorkspaceOut(wsCopying.id, wsCopying.repo, relPath)}
        />
      )}

      {naming && (
        <NameSheet
          label={`New ${naming.template.name}`}
          nameOf={(title) => renderName(naming.template, vars(title))}
          dir={naming.dir}
          repo={naming.repo}
          repos={shownRepos}
          // Folders belong to a repository, so choosing another starts at
          // that repository's remembered folder, or its root.
          onRepoChange={(repo) =>
            setNaming({ repo, dir: lastPlanDir(repo) ?? "", template: naming.template })
          }
          dirs={folderChoices}
          onDirChange={(dir) => setNaming({ ...naming, dir })}
          onCancel={() => setNaming(null)}
          onCreate={(relPath, title) =>
            void makeFile(naming.repo, relPath, title, naming.template)
          }
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
        repos={shownRepos}
        settings={settings}
        set={set}
        onOpenFile={(r, p) => void openFile(r, p)}
        onSelectRepo={setActiveRepoPath}
        onAddRepo={() => void addRepo()}
        templates={templates}
        onNewFromTemplate={newHere}
        onSave={() => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          void flush();
        }}
        onView={(v) => {
          if (v === "settings") {
            setKeyboardOpen(false);
            setSettingsOpen(true);
          } else goto(v);
        }}
        onOpenSettingsFile={openSettingsFile}
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
            ? api.searchPlans(activeRepoPath, query, settings.showIgnored, !settings.showAllFiles)
            : Promise.resolve([])
        }
        onOpenAt={(r, f, line, q) =>
          void openFile(r, f).then(() => {
            // In-file find is the missing half of cross-file search: the hit
            // opens with the bar seeded — query prefilled, the match nearest
            // the hit line current — instead of landing at the top and reading.
            findSeed.current = { line };
            findReturn.current = null;
            setFind((prev) => ({ query: q, focusSeq: (prev?.focusSeq ?? 0) + 1 }));
          })
        }
        onFind={openFind}
        onPerf={() => setPerf(true)}
        onCheckUpdates={() => void lookForUpdate(true)}
        onReleaseNotes={() => void showNotes()}
        gitCommands={gitCommands}
        skillFiles={
          activeRepoPath ? SKILLS.map((k) => ({ name: k.name, label: k.label })) : []
        }
        onOpenSkill={(name) => void openSkill(name)}
        hasMatter={matter !== null}
        canEdit={!!activePath}
        canHandOff={!!activePath && chat !== false}
        onHandOff={(kind) => void handOff(kind)}
        onCopyAgentCommand={() => void copyAgentCommand()}
        shareWorkspaceId={wsIdOf(activePath)}
        onCopyShareLink={(id) => void copyShareLink(id)}
        onShareLinks={(id) => setWsSharing(id)}
        chats={chats}
        onNewChat={newChat}
        onOpenChat={openChat}
        onDeleteChat={(id) => void deleteChat(id)}
        onRenameChat={renameChat}
        allChats={allChats}
        onOpenChatIn={openChatIn}
        running={running}
        agents={agents}
        onUseAgent={(id) => set({ chatCommand: id })}
        onCloseAll={() => void closeAllTabs()}
        openCount={tabs.length}
        onCycleTab={cycleTab}
        onMatter={() => {
          if (matter === null) onMatterChange("");
          setMatterOpen(true);
        }}
        statuses={statusChoices}
        currentStatus={matter !== null ? matterValue(matter, "status") : null}
        onSetStatus={setStatus}
        routing={{
          model: matter !== null ? matterValue(matter, "model") : null,
          effort: matter !== null ? matterValue(matter, "effort") : null,
        }}
        routingChoices={routingChoices}
        onSetRouting={setRouting}
        onScaffoldMatter={scaffoldMatter}
        keymap={keymap}
        onShortcuts={() => setShortcuts(true)}
        splitOpen={!!split}
        onSplit={toggleSplit}
        onSplitDir={() => setSplitDir((d) => (d === "row" ? "column" : "row"))}
        onSwapPanes={() => void swapPanes()}
        onPaneView={(v) => goto(v, true)}
        canSplitSame={!!activePath && !!activeRepoPath && activeRepoPath !== MEMORY}
        onSplitSame={splitSame}
      />

      {tabMenu && (
        <div
          className="ctx"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="ctx-path">{tabMenu.path}</p>
          <button
            className="ctx-item"
            onClick={() => {
              const m = tabMenu;
              setTabMenu(null);
              void (m.strip === "main"
                ? openInSplit(m.repo, m.path)
                : moveToMain(m.repo, m.path));
            }}
          >
            {tabMenu.strip === "main"
              ? split
                ? "Move to the split"
                : "Open to the side"
              : "Move to the main pane"}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              const m = tabMenu;
              setTabMenu(null);
              if (m.strip === "main") void closeTab(m.repo, m.path);
              else closeSplitTab(m.repo, m.path);
            }}
          >
            Close
          </button>
        </div>
      )}

      {shortcuts && (
        <ShortcutSheet
          overrides={settings.keyOverrides}
          preset={settings.keyPreset}
          onOverrides={(next) => {
            track("shortcut_customised", { overrides: Object.keys(next).length });
            set({ keyOverrides: next });
          }}
          onClose={() => setShortcuts(false)}
        />
      )}

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
