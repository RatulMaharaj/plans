import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type GitStatus, type PlanFile, type RepoInfo } from "./api";
import { Editor } from "./Editor";
import { GitPanel } from "./GitPanel";
import { DiffView } from "./DiffView";
import { SettingsPage } from "./SettingsPage";
import {
  applySettings,
  DEFAULTS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings";
import "./App.css";

const KEY = { repos: "plans.repos.v1", last: "plans.last.v1" };

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

type Toast = { text: string; kind: "info" | "error" } | null;
type View = "write" | "changes" | "settings";

/** The git mark shown against a plan in the index. */
type Mark = "clean" | "new" | "mod" | "staged";
const GLYPH: Record<Mark, string> = { clean: "·", new: "+", mod: "~", staged: "▲" };
const MARK_WORD: Record<Mark, string> = {
  clean: "committed",
  new: "new",
  mod: "edited",
  staged: "staged",
};

function titleOf(f: PlanFile) {
  return f.name.replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ");
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [offDirs, setOffDirs] = useState<Record<string, string[]>>({});
  const [files, setFiles] = useState<PlanFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [docKey, setDocKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [view, setView] = useState<View>("write");
  const [epoch, setEpoch] = useState(0);

  const activeRepo = useMemo(
    () => repos.find((r) => r.path === activeRepoPath) ?? null,
    [repos, activeRepoPath],
  );

  const scope = useMemo(() => {
    if (!activeRepo) return [];
    const off = offDirs[activeRepo.path] ?? [];
    return activeRepo.planDirs.filter((d) => !off.includes(d));
  }, [activeRepo, offDirs]);

  const notify = useCallback((text: string, kind: "info" | "error" = "info") => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), kind === "error" ? 6000 : 2200);
  }, []);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  // --- boot ----------------------------------------------------------------
  useEffect(() => {
    const paths = stored<string[]>(KEY.repos, []);
    if (!paths.length) return;
    Promise.all(paths.map((p) => api.openRepo(p).catch(() => null))).then((rs) => {
      const ok = rs.filter(Boolean) as RepoInfo[];
      setRepos(ok);
      const last = stored<string | null>(KEY.last, null);
      setActiveRepoPath(ok.find((r) => r.path === last)?.path ?? ok[0]?.path ?? null);
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(KEY.repos, JSON.stringify(repos.map((r) => r.path)));
  }, [repos]);

  useEffect(() => {
    if (activeRepoPath) localStorage.setItem(KEY.last, JSON.stringify(activeRepoPath));
  }, [activeRepoPath]);

  // --- data ----------------------------------------------------------------
  const refreshFiles = useCallback(async () => {
    if (!activeRepo) return setFiles([]);
    try {
      setFiles(await api.listPlans(activeRepo.path, scope));
    } catch (e) {
      notify(String(e), "error");
    }
  }, [activeRepo, scope, notify]);

  const refreshStatus = useCallback(async () => {
    if (!activeRepo) return setStatus(null);
    try {
      setStatus(await api.gitStatus(activeRepo.path, scope));
    } catch (e) {
      notify(String(e), "error");
    }
  }, [activeRepo, scope, notify]);

  useEffect(() => {
    void refreshFiles();
    void refreshStatus();
  }, [refreshFiles, refreshStatus]);

  // Plans written by Claude Code in a terminal should turn up on their own.
  useEffect(() => {
    if (settings.watchSeconds <= 0) return;
    const t = setInterval(() => {
      if (!dirty && !busy) {
        void refreshFiles();
        void refreshStatus();
      }
    }, settings.watchSeconds * 1000);
    return () => clearInterval(t);
  }, [refreshFiles, refreshStatus, dirty, busy, settings.watchSeconds]);

  /** path -> mark, so the index carries git state with the panel closed. */
  const marks = useMemo(() => {
    const m = new Map<string, Mark>();
    for (const e of status?.entries ?? []) {
      if (e.index !== " " && e.index !== "?") m.set(e.path, "staged");
      else if (e.worktree === "?") m.set(e.path, "new");
      else if (e.worktree !== " ") m.set(e.path, "mod");
    }
    return m;
  }, [status]);

  const changeCount = status?.entries.length ?? 0;

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
      if (!info.planDirs.length) notify(`No plans folder in ${info.name}`, "error");
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
      }
    },
    [activeRepoPath],
  );

  const toggleDir = (dir: string) => {
    if (!activeRepo) return;
    setOffDirs((prev) => {
      const off = prev[activeRepo.path] ?? [];
      return {
        ...prev,
        [activeRepo.path]: off.includes(dir)
          ? off.filter((d) => d !== dir)
          : [...off, dir],
      };
    });
  };

  // --- editing -------------------------------------------------------------
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ repo: string; path: string; text: string } | null>(null);

  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    try {
      await api.writePlan(p.repo, p.path, p.text);
      setDirty(false);
      setSavedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
      void refreshStatus();
    } catch (e) {
      notify(String(e), "error");
    }
  }, [notify, refreshStatus]);

  const onChange = useCallback(
    (markdown: string) => {
      if (!activeRepo || !activePath) return;
      setContent(markdown);
      setDirty(true);
      pending.current = { repo: activeRepo.path, path: activePath, text: markdown };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), 700);
    },
    [activeRepo, activePath, flush],
  );

  const openFile = useCallback(
    async (relPath: string) => {
      if (!activeRepo) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flush();
      try {
        const text = await api.readPlan(activeRepo.path, relPath);
        setActivePath(relPath);
        setContent(text);
        setDocKey(`${activeRepo.path}::${relPath}::${Date.now()}`);
        setDirty(false);
        setSavedAt(null);
        setView((v) => (v === "settings" ? "write" : v));
      } catch (e) {
        notify(String(e), "error");
      }
    },
    [activeRepo, flush, notify],
  );

  const newPlan = async () => {
    if (!activeRepo) return;
    const dir = scope[0];
    if (!dir) return notify("This repo has no plans folder", "error");
    const title = window.prompt("Title for the new plan");
    if (!title?.trim()) return;
    const slug =
      title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
      "untitled";
    const relPath = `${dir}/${slug}.md`;
    try {
      await api.createPlan(activeRepo.path, relPath, title.trim());
      await refreshFiles();
      await openFile(relPath);
      void refreshStatus();
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const deleteActive = async () => {
    if (!activeRepo || !activePath) return;
    if (!window.confirm(`Delete ${activePath} from disk?`)) return;
    try {
      await api.deletePlan(activeRepo.path, activePath);
      setActivePath(null);
      setContent("");
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

  // --- keys ----------------------------------------------------------------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        void flush();
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        set({ showGit: !settings.showGit });
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setView((v) => (v === "changes" ? "write" : "changes"));
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setView((v) => (v === "settings" ? "write" : "settings"));
      } else if (e.key === "Escape" && view === "settings") {
        setView("write");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [flush, set, settings.showGit, view]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.relPath.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  const activeMark: Mark = activePath
    ? dirty
      ? "mod"
      : (marks.get(activePath) ?? "clean")
    : "clean";

  const gitOpen = settings.showGit && !!activeRepo && view !== "settings";

  return (
    <div className={`app ${settings.showStatusBar ? "" : "no-bar"}`}>
      {/* --- rail ---------------------------------------------------------- */}
      <header className="rail">
        <span className="wordmark">Plans</span>
        <span className="rail-sep" />

        {repos.length > 0 ? (
          <>
            <select
              className="repo-select"
              value={activeRepoPath ?? ""}
              aria-label="Repository"
              onChange={(e) => {
                if (e.target.value === "__add") void addRepo();
                else setActiveRepoPath(e.target.value);
              }}
            >
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
              <option value="__add">Add a repository…</option>
            </select>
            <span className="caret">▾</span>
            {activeRepo && <span className="branch">{activeRepo.branch}</span>}
          </>
        ) : (
          <button className="rail-btn on" onClick={addRepo}>
            Add a repository
          </button>
        )}

        <span className="rail-spacer" />

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
      </header>

      {/* --- body ---------------------------------------------------------- */}
      <div className={`body ${gitOpen ? "with-git" : ""}`}>
        <section className="index">
          <div className="index-head">
            <span className="tag">Index</span>
            <span className="tag">{visible.length || ""}</span>
          </div>

          <input
            className="filter"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          {activeRepo && activeRepo.planDirs.length > 1 && (
            <div className="scopes">
              {activeRepo.planDirs.map((d) => (
                <button
                  key={d}
                  className={`scope ${scope.includes(d) ? "on" : ""}`}
                  onClick={() => toggleDir(d)}
                  aria-pressed={scope.includes(d)}
                >
                  {d}
                </button>
              ))}
            </div>
          )}

          <div className="entries">
            {!activeRepo && (
              <p className="none pad">Add a repository to begin.</p>
            )}
            {activeRepo && !activeRepo.planDirs.length && (
              <p className="none pad">No plans folder in this repository.</p>
            )}
            {visible.map((f) => {
              const mark: Mark =
                f.relPath === activePath && dirty
                  ? "mod"
                  : (marks.get(f.relPath) ?? "clean");
              return (
                <button
                  key={f.relPath}
                  className={`entry ${
                    f.relPath === activePath && view !== "settings" ? "active" : ""
                  }`}
                  onClick={() => void openFile(f.relPath)}
                >
                  <span className="entry-title">{titleOf(f)}</span>
                  <span className="entry-meta">
                    <span className={`mark ${mark}`} title={MARK_WORD[mark]}>
                      {GLYPH[mark]}
                    </span>
                    <span className="entry-folder">{f.dir || "/"}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="index-foot">
            <button className="new-plan" onClick={newPlan} disabled={!activeRepo}>
              New plan
            </button>
          </div>
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
              <div className="page-head">
                <span className="page-path">{activePath ?? ""}</span>
                {activePath && (
                  <span className="page-actions">
                    <span className="segmented small">
                      <button
                        className={view === "write" ? "on" : ""}
                        onClick={() => setView("write")}
                      >
                        Write
                      </button>
                      <button
                        className={view === "changes" ? "on" : ""}
                        onClick={() => setView("changes")}
                        title="Live diff against the last commit (⌘D)"
                      >
                        Changes
                      </button>
                    </span>
                    <button className="rail-btn" onClick={deleteActive}>
                      Delete
                    </button>
                  </span>
                )}
              </div>

              {!activePath ? (
                <div className="blank">
                  <p className="blank-line">
                    {activeRepo
                      ? "Choose a plan from the index, or start a new one."
                      : "Point the app at a repository and it will show you the plans inside it."}
                  </p>
                </div>
              ) : view === "write" ? (
                <Editor
                  docKey={docKey}
                  initialValue={content}
                  spellcheck={settings.spellcheck}
                  onChange={onChange}
                />
              ) : (
                <div className="editor-host">
                  <DiffView
                    repo={activeRepo!.path}
                    relPath={activePath}
                    buffer={content}
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
            scope={scope}
            status={status}
            busy={busy}
            onRun={onRun}
            notify={notify}
          />
        )}
      </div>

      {/* --- bar ----------------------------------------------------------- */}
      {settings.showStatusBar && (
        <footer className="bar">
          {activePath && view !== "settings" ? (
            <>
              <span className={`mark ${activeMark}`}>{GLYPH[activeMark]}</span>
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
          <span>⌘G git · ⌘D changes · ⌘, settings</span>
        </footer>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
