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
import { codeTheme } from "./code-theme";
import type { Settings } from "./settings";

type Props = {
  value: string;
  onChange: (text: string) => void;
  settings: Settings;
  /** Changing file rebuilds the editor, so history doesn't cross documents. */
  docKey: string;
  /** False while the page is showing: stay mounted, but do no work. */
  active: boolean;
};

/** Source has its own scale, set apart from both the page and code blocks. */
const surface = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "calc(var(--doc-size) * 0.72)",
    background: "var(--paper)",
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
    paddingRight: "10px",
  },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--ink-2)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "3ch" },
});

export function SourceView({ value, onChange, settings, docKey, active }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pending = useRef<number | null>(null);
  /** The last text this view sent out, so its own echo can be recognised. */
  const sent = useRef<string | null>(null);

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
  }, [docKey, settings.sourceLineNumbers, settings.sourceWrap]);

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
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      selection: { anchor: at, head },
      scrollIntoView: false,
    });
    v.scrollDOM.scrollTop = top;
  }, [value, active]);

  return <div className={`source ${settings.sourceWrap ? "" : "nowrap"}`} ref={host} />;
}
