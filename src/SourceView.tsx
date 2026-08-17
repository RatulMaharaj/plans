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

export function SourceView({ value, onChange, settings, docKey }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
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
      v.destroy();
      view.current = null;
    };
    // `value` is deliberately excluded: it is pushed in below, not remounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, settings.sourceLineNumbers, settings.sourceWrap]);

  /**
   * Text from outside — a reload, a conflict taken, an edit made in the page —
   * replaces the document, but only when it genuinely differs. Comparing first
   * is what keeps the cursor still while you type.
   */
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div className={`source ${settings.sourceWrap ? "" : "nowrap"}`} ref={host} />;
}
