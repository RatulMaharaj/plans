import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import "./editor-theme.css";

type Props = {
  /** Changing this key tears down and rebuilds the editor with fresh content. */
  docKey: string;
  initialValue: string;
  spellcheck: boolean;
  onChange: (markdown: string) => void;
};

/**
 * Milkdown Crepe gives us a WYSIWYG surface whose source of truth is markdown,
 * so what lands on disk stays diff-friendly for git.
 */
export function Editor({ docKey, initialValue, spellcheck, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;

    const crepe = new Crepe({ root, defaultValue: initialValue });

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        if (markdown !== prev) onChangeRef.current(markdown);
      });
    });

    crepe.create().catch((e) => console.error("editor failed to start", e));

    return () => {
      crepe.destroy();
    };
    // initialValue is intentionally excluded: docKey drives remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Toggling spellcheck shouldn't rebuild the document, so it's set on the
  // live contenteditable rather than passed at construction.
  useEffect(() => {
    const el = hostRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (el) el.spellcheck = spellcheck;
  }, [spellcheck, docKey]);

  return <div className="editor-host" ref={hostRef} />;
}
