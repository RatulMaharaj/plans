/**
 * The second pane: one more document, side by side with the main one.
 *
 * Deliberately self-contained. The main editor's per-document state lives as
 * singletons across App.tsx — buffer, stamp, pending write, conflict — and
 * extracting all of it into a shared `Pane` is a rewrite this feature does not
 * need to hold hostage. This component carries its own copy of exactly that
 * cluster: its own buffer, its own save machinery against its own stamp, its
 * own watcher, its own view. Two panes that cannot reach into each other's
 * state cannot save against each other's stamps.
 *
 * Two panes and no more, in writing: recursive splits are where editors grow
 * a layout tree, a serialization format for it, and focus rules nobody
 * remembers. For a plans editor on a laptop screen, two is the useful number.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DiffView } from "./DiffView";
import { Editor } from "./Editor";
import { FrontmatterSheet } from "./Frontmatter";
import { SourceView } from "./SourceView";
import { isMarkdownPath, joinFrontmatter, matterValue, splitFrontmatter, statusTone } from "./matter";
import { displayName } from "./FileTree";
import type { FindHandle } from "./find";
import type { Settings } from "./settings";

type Props = {
  repo: string;
  relPath: string;
  settings: Settings;
  author: string;
  /** Set from the chrome's one view switch — global, both panes at once. */
  view: "write" | "source" | "diff";
  /** Whether this buffer has a commit to diff against; false falls back to Source. */
  canDiff: boolean;
  /** Bumped when git state moves, so the diff re-reads. */
  epoch: number;
  /** This pane's own tab set — each pane keeps its own strip. */
  tabs: { repo: string; path: string }[];
  onSelectTab: (repo: string, path: string) => void;
  onCloseTab: (repo: string, path: string) => void;
  /** The shared tab-drag machinery: press to maybe-drag, swallow the click. */
  onTabPress: (repo: string, path: string, e: React.PointerEvent) => void;
  onTabMenu: (repo: string, path: string, e: React.MouseEvent) => void;
  onStripClickCapture: (e: React.MouseEvent) => void;
  /** Painted on the header so a keystroke cannot land in the wrong document. */
  focused: boolean;
  /** Keystrokes are going into this pane's document right now. */
  editing: boolean;
  onFocus: () => void;
  onClose: () => void;
  notify: (msg: string, kind?: "info" | "error") => void;
  /** ⌘S while this pane has focus lands here. */
  flushRef: React.MutableRefObject<(() => Promise<void>) | null>;
  /** ⌘-click on a link in this pane. */
  onOpenLink?: (href: string) => void;
  /**
   * The main pane's text when both panes hold the same file, else null.
   * Same-file panes mirror instantly: this side adopts the other's edits
   * with nothing pending, and reports its own through `onLiveEdit`.
   */
  liveText: string | null;
  onLiveEdit: (text: string) => void;
  /**
   * ⌘F while this pane has focus. The pane routes App's one handle to
   * whichever of its surfaces is showing — null over a diff, which gets
   * nothing — and hosts the bar so it floats over the pane being searched.
   */
  findRef?: React.MutableRefObject<FindHandle | null>;
  onFindCount?: (current: number, total: number) => void;
  findBar?: React.ReactNode;
};

export function SplitPane({
  repo,
  relPath,
  settings,
  author,
  view,
  canDiff,
  epoch,
  tabs,
  onSelectTab,
  onCloseTab,
  editing,
  onTabPress,
  onTabMenu,
  onStripClickCapture,
  focused,
  onFocus,
  onClose,
  notify,
  flushRef,
  onOpenLink,
  liveText,
  onLiveEdit,
  findRef,
  onFindCount,
  findBar,
}: Props) {
  const [body, setBody] = useState("");
  const [matter, setMatter] = useState<string | null>(null);
  const [docKey, setDocKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [matterOpen, setMatterOpen] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const stamp = useRef<string | null>(null);
  const original = useRef<{ matter: string | null; raw: string; eol: boolean }>({
    matter: null,
    raw: "",
    eol: true,
  });
  const pending = useRef<string | null>(null);
  const writing = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const assemble = useCallback(
    (m: string | null, b: string) => {
      const text = joinFrontmatter(m, b, original.current);
      return original.current.eol && text && !text.endsWith("\n") ? `${text}\n` : text;
    },
    [],
  );
  const source = assemble(matter, body);

  const load = useCallback(async () => {
    try {
      const { content: text, stamp: at } = await api.readPlan(repo, relPath);
      stamp.current = at;
      const split = settings.showFrontmatter && isMarkdownPath(relPath)
        ? splitFrontmatter(text)
        : { matter: null, body: text, raw: "" };
      original.current = { matter: split.matter, raw: split.raw, eol: /\n$/.test(text) };
      pending.current = null;
      setMatter(split.matter);
      setBody(split.body);
      setDocKey(`${repo}::${relPath}::${Date.now()}`);
      setDirty(false);
      setConflict(null);
      setMatterOpen(false);
    } catch (e) {
      notify(`Could not open ${relPath}: ${String(e).replace(/^Error:\s*/, "")}`, "error");
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, relPath, settings.showFrontmatter]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    const text = pending.current;
    if (text === null) return;
    pending.current = null;
    writing.current = true;
    try {
      // Conditional on the version this pane loaded — the main pane's stamp is
      // its own business, which is the whole reason this state lives here.
      stamp.current = await api.writePlan(repo, relPath, text, stamp.current ?? undefined);
      setDirty(false);
    } catch (e) {
      if (String(e).includes("STALE")) {
        pending.current = text; // no keystroke lost while the reader decides
        const theirs = await api.readPlan(repo, relPath).then(
          (r) => r.content,
          () => "",
        );
        setConflict(theirs);
      } else {
        notify(String(e), "error");
      }
    } finally {
      writing.current = false;
    }
  }, [repo, relPath, notify]);

  useEffect(() => {
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  }, [flush, flushRef]);

  const edited = useCallback(
    (m: string | null, b: string) => {
      setMatter(m);
      setBody(b);
      setDirty(true);
      pending.current = joinFrontmatter(m, b, original.current);
      if (original.current.eol && pending.current && !pending.current.endsWith("\n")) {
        pending.current += "\n";
      }
      if (liveText !== null && pending.current !== null) onLiveEdit(pending.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (settings.autosave === "afterDelay") {
        saveTimer.current = window.setTimeout(() => void flush(), settings.autosaveDelay * 1000);
      }
    },
    [flush, settings.autosave, settings.autosaveDelay, liveText, onLiveEdit],
  );

  /*
   * The other half of same-file mirroring: the main pane typed, this side
   * follows. Never while this pane is focused — the focused pane owns the
   * buffer — and the Write surface rebuilds on a trailing debounce, since a
   * built document cannot take new text per keystroke the way the raw views
   * take a prop.
   */
  const liveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (liveText === null || focused) return;
    if (liveText === source) return;
    const sp = settings.showFrontmatter && isMarkdownPath(relPath)
      ? splitFrontmatter(liveText)
      : { matter: null, body: liveText, raw: "" };
    original.current = { matter: sp.matter, raw: sp.raw, eol: /\n$/.test(liveText) };
    pending.current = null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setMatter(sp.matter);
    setBody(sp.body);
    setDirty(false);
    if (view === "write") {
      clearTimeout(liveTimer.current);
      liveTimer.current = window.setTimeout(
        () => setDocKey(`${repo}::${relPath}::${Date.now()}`),
        250,
      );
    }
    // Adopt exactly when the mirrored text moves — everything else is a ref
    // or would re-run this on our own edits echoing back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveText]);

  // Pane blur is the save cue for "onBlur" — moving to the other document is
  // exactly the moment a reader expects this one to be written.
  useEffect(() => {
    if (!focused && settings.autosave === "onBlur") void flush();
  }, [focused, settings.autosave, flush]);

  // Nothing pending survives the pane closing.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void flush();
    },
    [flush],
  );

  // The same watcher rules as the main pane: clean takes the new version,
  // dirty says so and lets the reader choose — never silently.
  useEffect(() => {
    if (settings.watchSeconds <= 0) return;
    const t = setInterval(async () => {
      if (conflict || writing.current) return;
      const at = await api.statPlan(repo, relPath).catch(() => null);
      if (!at || at === stamp.current || at === "absent") return;
      if (dirty || pending.current !== null) {
        const theirs = await api.readPlan(repo, relPath).then(
          (r) => r.content,
          () => "",
        );
        setConflict(theirs);
      } else {
        // The other pane's autosave of this same text is not news: take the
        // stamp and stay put, so nothing rebuilds under the reader.
        const theirs = await api.readPlan(repo, relPath).catch(() => null);
        if (theirs && theirs.content === source) {
          stamp.current = theirs.stamp;
          return;
        }
        await load();
      }
    }, Math.max(1, settings.watchSeconds) * 1000);
    return () => clearInterval(t);
  }, [repo, relPath, settings.watchSeconds, dirty, conflict, load]);

  // The editor reads `initialValue` only when `docKey` changes, so edits made
  // in the source view reach it by rebuilding it on the way back — and only
  // then; an untouched round trip keeps the instance. The view itself is set
  // from the chrome's switch, so the rebuild watches the prop.
  const shown: "write" | "source" | "diff" = view === "diff" && !canDiff ? "source" : view;
  const sourceTouched = useRef(false);
  const prevView = useRef(shown);
  useEffect(() => {
    if (prevView.current !== "write" && shown === "write" && sourceTouched.current) {
      sourceTouched.current = false;
      setDocKey(`${repo}::${relPath}::${Date.now()}`);
    }
    prevView.current = shown;
  }, [shown, repo, relPath]);

  /*
   * ⌘F's route into this pane: App holds one handle, the pane forwards it to
   * whichever surface is showing. Null over a diff — find is not offered
   * there — and clear() reaches both surfaces, so no paint outlives the bar
   * on a surface set aside with CSS.
   */
  const writeFind = useRef<FindHandle | null>(null);
  const sourceFind = useRef<FindHandle | null>(null);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  useEffect(() => {
    if (!findRef) return;
    const pick = () =>
      shownNow.current === "write" && isMarkdownPath(relPath)
        ? writeFind.current
        : sourceFind.current;
    const handle: FindHandle = {
      set: (q, seek) => pick()?.set(q, seek),
      next: () => pick()?.next(),
      prev: () => pick()?.prev(),
      clear: () => {
        writeFind.current?.clear();
        sourceFind.current?.clear();
      },
    };
    findRef.current = shown === "diff" ? null : handle;
    return () => {
      findRef.current = null;
    };
  }, [findRef, shown, relPath]);

  const status = matter !== null ? matterValue(matter, "status") : null;
  const who =
    matter !== null ? (matterValue(matter, "owner") ?? matterValue(matter, "assignee")) : null;
  const due = matter !== null ? matterValue(matter, "due") : null;
  const overdue = !!due && !Number.isNaN(Date.parse(due)) && Date.parse(due) < Date.now();

  return (
    <div
      className={`split-pane ${focused ? "focused" : ""}`}
      onFocusCapture={onFocus}
      onMouseDownCapture={onFocus}
    >
      {/* The same skeleton as the main pane — a tab strip, then a header —
          so the two panes read as siblings, at the same height. No view
          buttons: the chrome's switch acts on whichever pane has focus. */}
      <div className="tab-row">
        <div className="tabs" data-strip="split" role="tablist" onClickCapture={onStripClickCapture}>
          {tabs.map((t) => {
            const on = t.repo === repo && t.path === relPath;
            const tabName = t.path.split("/").pop() ?? t.path;
            return (
              <span
                className={`tab ${on ? "on" : ""}${on && editing ? " editing" : ""}`}
                key={`${t.repo}::${t.path}`}
              >
                <button
                  className="tab-name"
                  role="tab"
                  aria-selected={on}
                  title={t.path}
                  onClick={() => onSelectTab(t.repo, t.path)}
                  onAuxClick={(e) => {
                    if (e.button === 1) onCloseTab(t.repo, t.path);
                  }}
                  onPointerDown={(e) => onTabPress(t.repo, t.path, e)}
                  onContextMenu={(e) => onTabMenu(t.repo, t.path, e)}
                >
                  {displayName(tabName, settings.showExtensions)}
                  {on && dirty ? " •" : ""}
                </button>
                <button
                  className="tab-close"
                  aria-label={`Close ${tabName}`}
                  onClick={() => onCloseTab(t.repo, t.path)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      </div>
      <div className="page-head">
        <span className="page-path">{relPath}</span>
        <span className="page-actions">
          {/* The same frontmatter facts the main header shows for its file. */}
          {status && (
            <span
              className={`status-badge tone-${statusTone(status)}`}
              title="status: from this file's frontmatter"
            >
              {status}
            </span>
          )}
          {who && (
            <span className="matter-owner" title="owner: from this file's frontmatter">
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
          {/* Only where there is one to edit — the same rule as the main
              header. No close button: the pane closes from the palette, or
              when its last tab does. */}
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
      </div>

      {matterOpen && (
        <FrontmatterSheet
          matter={matter}
          onChange={(next) => edited(next, body)}
          onClose={() => setMatterOpen(false)}
        />
      )}

      {conflict !== null && (
        <div className="conflict">
          <p className="conflict-line">This file changed on disk while you were editing it.</p>
          <span className="conflict-acts">
            <button
              className="rail-btn"
              onClick={() => {
                setConflict(null);
                pending.current = source;
                stamp.current = null; // write unconditionally: mine survives
                void flush();
              }}
            >
              Keep mine
            </button>
            <button
              className="rail-btn"
              onClick={() => {
                pending.current = null;
                setConflict(null);
                void load();
              }}
            >
              Take theirs
            </button>
          </span>
        </div>
      )}

      {findBar}

      {/* Both writing surfaces stay mounted, the hidden one put aside with
          CSS — the same trick the main pane uses to keep switching instant.
          Diff, like the main pane's, is built when asked for. */}
      {shown !== "diff" ? (
        <>
          {/* Not mounted at all for a non-markdown file — even parked aside,
              Milkdown would parse it as markdown, and that document must
              never exist for a file it could rewrite. */}
          {isMarkdownPath(relPath) && (
          <div className={`surface ${shown === "write" ? "" : "aside"}`}>
            <Editor
              docKey={docKey}
              repo={repo}
              relPath={relPath}
              initialValue={body}
              spellcheck={settings.spellcheck}
              imageFolder={settings.imageFolder}
              author={author}
              onChange={(md) => edited(matter, md)}
              onOpenLink={onOpenLink}
              findRef={writeFind}
              onFindCount={onFindCount}
            />
          </div>
          )}
          <div className={`surface ${shown === "source" ? "" : "aside"}`}>
            <SourceView
              value={source}
              onChange={(text) => {
                sourceTouched.current = true;
                const split = settings.showFrontmatter && isMarkdownPath(relPath)
                  ? splitFrontmatter(text)
                  : { matter: null, body: text, raw: original.current.raw };
                edited(split.matter, split.body);
              }}
              settings={settings}
              docKey={docKey}
              active={shown === "source"}
              findRef={sourceFind}
              onFindCount={onFindCount}
            />
          </div>
        </>
      ) : (
        <div className="editor-host">
          {/* Keyed by file, as in the main pane: all diff state per document. */}
          <DiffView
            key={`${repo}::${relPath}`}
            repo={repo}
            relPath={relPath}
            buffer={source}
            onEdit={(text) => {
              sourceTouched.current = true;
              const split = settings.showFrontmatter && isMarkdownPath(relPath)
                ? splitFrontmatter(text)
                : { matter: null, body: text, raw: original.current.raw };
              edited(split.matter, split.body);
            }}
            settings={settings}
            epoch={epoch}
          />
        </div>
      )}
    </div>
  );
}
