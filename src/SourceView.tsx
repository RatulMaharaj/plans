/**
 * The raw markdown, as a real editor.
 *
 * A textarea was honest but blind: no highlighting, no line numbers, no undo
 * worth the name. This is CodeMirror with the markdown mode and the same theme
 * the code blocks use, so the source reads in the app's own ink.
 *
 * The buffer is still App's — every change goes out through onChange, and text
 * arriving from elsewhere (a reload, a conflict resolved, an agent's write) is
 * pushed in without disturbing the cursor.
 */
import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { codeTheme } from "./code-theme";
import { FIND_CAP, findCaseSensitive, type FindHandle } from "./find";
import type { Settings } from "./settings";

type Props = {
  value: string;
  onChange: (text: string) => void;
  settings: Settings;
  /** Changing file rebuilds the editor, so history doesn't cross documents. */
  docKey: string;
  /** False while the page is showing: stay mounted, but do no work. */
  active: boolean;
  /** Show, never edit: a shared document's source, which the room owns. */
  readOnly?: boolean;
  /** ⌘F's engine for this surface, registered while the view is mounted. */
  findRef?: React.MutableRefObject<FindHandle | null>;
  onFindCount?: (current: number, total: number) => void;
};

/**
 * The source takes the code size, not a fraction of the reading size.
 *
 * They coincided at 12px, but by accident: one followed the text size setting
 * and the other did not, so changing the page's type moved one and left the
 * other. Both are mono, both are the file rather than the page, and one setting
 * should govern them.
 */
const surface = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--code-size, 12px)",
    /**
     * Paper, not the code block's ground: the source is the document itself,
     * with nothing to be set apart from. Said through --cm-surface, which the
     * shared theme reads, so the two never disagree.
     */
    background: "var(--cm-surface)",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.75",
    padding: "26px 0",
  },
  ".cm-content": { caretColor: "var(--ink)" },
  ".cm-gutters": {
    background: "var(--paper)",
    color: "var(--ink-3)",
    border: "none",
    paddingRight: "12px",
  },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--ink-2)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "3ch", textAlign: "right" },
});

export function SourceView({ value, onChange, settings, docKey, active, readOnly, findRef, onFindCount }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pending = useRef<number | null>(null);
  /** True while a value from outside is being written into the editor. */
  const pushing = useRef(false);
  /** The last text this view sent out, so its own echo can be recognised. */
  const sent = useRef<string | null>(null);

  const onFindCountRef = useRef(onFindCount);
  onFindCountRef.current = onFindCount;
  /** The query being highlighted, so next/prev and doc changes can recount. */
  const liveSearch = useRef<SearchQuery | null>(null);

  /** Every match, in order, capped — counting is the cap's only casualty. */
  const findRanges = (v: EditorView, sq: SearchQuery) => {
    const out: { from: number; to: number }[] = [];
    const c = sq.getCursor(v.state.doc);
    while (out.length < FIND_CAP) {
      const n = c.next();
      if (n.done) break;
      out.push(n.value);
    }
    return out;
  };

  const reportFind = (v: EditorView, sq: SearchQuery) => {
    const all = findRanges(v, sq);
    const sel = v.state.selection.main;
    const cur = all.findIndex((r) => r.from === sel.from && r.to === sel.to);
    onFindCountRef.current?.(cur + 1, all.length);
  };

  /**
   * ⌘F's engine: @codemirror/search's query machinery — SearchQuery, its
   * highlighter, findNext — and none of its panel. The highlighter only
   * paints while the panel state says "open", so the extension below opens a
   * panel that renders nothing; the visible bar is the app's own.
   */
  useEffect(() => {
    if (!findRef) return;
    const handle: FindHandle = {
      set: (q, seek) => {
        const v = view.current;
        if (!v) return;
        if (!q) {
          handle.clear();
          onFindCountRef.current?.(0, 0);
          return;
        }
        const sq = new SearchQuery({ search: q, literal: true, caseSensitive: findCaseSensitive(q) });
        const same = liveSearch.current?.search === q;
        liveSearch.current = sq;
        openSearchPanel(v);
        v.dispatch({ effects: setSearchQuery.of(sq) });
        const all = findRanges(v, sq);
        if (!all.length) {
          onFindCountRef.current?.(0, 0);
          return;
        }
        if (seek !== undefined) {
          // Seeded from a palette hit: that occurrence is the current match.
          const m = all[Math.min(seek, all.length - 1)];
          v.dispatch({
            selection: { anchor: m.from, head: m.to },
            effects: EditorView.scrollIntoView(m.from, { y: "center" }),
          });
        } else {
          const sel = v.state.selection.main;
          const on = all.some((r) => r.from === sel.from && r.to === sel.to);
          // An unchanged query keeps its match; a new one starts at the cursor.
          if (!same || !on) findNext(v);
        }
        reportFind(v, sq);
      },
      next: () => {
        const v = view.current;
        if (!v || !liveSearch.current) return;
        findNext(v);
        reportFind(v, liveSearch.current);
      },
      prev: () => {
        const v = view.current;
        if (!v || !liveSearch.current) return;
        findPrevious(v);
        reportFind(v, liveSearch.current);
      },
      clear: () => {
        const v = view.current;
        if (!v) return;
        liveSearch.current = null;
        v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
        closeSearchPanel(v);
      },
    };
    findRef.current = handle;
    return () => {
      if (findRef.current === handle) findRef.current = null;
    };
  }, [findRef]);

  /** Anything typed in the last moment still reaches the buffer. */
  const flushPending = () => {
    if (!pending.current) return;
    clearTimeout(pending.current);
    pending.current = null;
    const v = view.current;
    if (!v) return;
    const text = v.state.doc.toString();
    sent.current = text;
    onChangeRef.current(text);
  };

  // Rebuilt when the file changes, or when a setting changes its shape.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown(),
      // The find machinery. Its state machine wants a panel before it will
      // highlight, so it gets one that renders nothing (and CSS hides the
      // empty strip); the bar people see is the app's own.
      search({ createPanel: () => ({ dom: document.createElement("div") }) }),
      codeTheme,
      surface,
      /**
       * Report on a pause, not on every key.
       *
       * Each report reaches App state, and an App render costs far more than a
       * CodeMirror transaction. Typing stays local to the editor; the buffer
       * catches up 180ms after you stop, which is well inside the autosave
       * delay and invisible in use.
       */
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        // A live find keeps its count honest while the text moves — an
        // agent's write through the watcher, or typing here.
        if (liveSearch.current) reportFind(u.view, liveSearch.current);
        // A value pushed in from outside is not typing: there is nothing to
        // send back, and a pending window opened for it would swallow the
        // next value that arrived inside it — and, for a shared document,
        // send the room its own text as an edit.
        if (readOnly || pushing.current) return;
        if (pending.current) clearTimeout(pending.current);
        pending.current = window.setTimeout(() => {
          pending.current = null;
          const v = view.current;
          if (!v) return;
          const text = v.state.doc.toString();
          sent.current = text;
          onChangeRef.current(text);
        }, 180);
      }),
    ];
    if (readOnly) extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    if (settings.sourceLineNumbers) extensions.push(lineNumbers(), highlightActiveLineGutter());
    if (settings.sourceWrap) extensions.push(EditorView.lineWrapping);

    const v = new EditorView({
      parent,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = v;
    return () => {
      flushPending();
      v.destroy();
      view.current = null;
    };
    // `value` is deliberately excluded: it is pushed in below, not remounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, settings.sourceLineNumbers, settings.sourceWrap, readOnly]);

  /**
   * Text from outside — a reload, a conflict taken, an edit made in the page.
   *
   * Only while this view is the one on screen. Replacing the document reparses
   * and re-highlights the whole file, and doing that on every keystroke typed
   * in the page — into a view nobody is looking at — is what made typing crawl.
   * It catches up in one go when it comes back into view.
   */
  useEffect(() => {
    if (!active || pending.current) return;
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc.toString();
    if (doc === value) return;

    /**
     * Ignore our own echo.
     *
     * The buffer is reassembled on the way back — frontmatter rejoined, the
     * file's trailing newline restored — so the text returning here can differ
     * from what was typed by a character that is not a change at all. Replacing
     * the document for that threw the cursor and the scroll to the top, which
     * is what pasting at the end of a long file looked like.
     */
    if (sent.current !== null && (value === sent.current || value === `${sent.current}\n`)) {
      return;
    }
    sent.current = null;

    // A genuine change from elsewhere: keep the cursor and the scroll where
    // they were, rather than starting the document over.
    const sel = v.state.selection.main;
    const top = v.scrollDOM.scrollTop;
    const at = Math.min(sel.anchor, value.length);
    const head = Math.min(sel.head, value.length);
    pushing.current = true;
    try {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        selection: { anchor: at, head },
        scrollIntoView: false,
      });
    } finally {
      pushing.current = false;
    }
    v.scrollDOM.scrollTop = top;
  }, [value, active]);

  return (
    <div
      className={`source ${settings.sourceWrap ? "" : "nowrap"}`}
      ref={host}
    />
  );
}
