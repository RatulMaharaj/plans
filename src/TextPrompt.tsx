/**
 * A one-line question.
 *
 * WKWebView has no window.prompt, so anything that needs a word from the reader
 * — a branch name, a commit message — asks here instead.
 */
import { useEffect, useRef, useState } from "react";

type Props = {
  title: string;
  placeholder?: string;
  /** Shown under the field: what will happen, in the ledger voice. */
  note?: string;
  confirm: string;
  /** Multi-line for a commit message, single for a name. */
  multiline?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
};

export function TextPrompt({
  title,
  placeholder,
  note,
  confirm,
  multiline,
  onCancel,
  onSubmit,
}: Props) {
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const submit = () => {
    if (value.trim()) onSubmit(value.trim());
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="matter-scrim" onMouseDown={onCancel}>
      <div className="matter-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="matter-head">
          <span className="tag">{title}</span>
        </div>
        {multiline ? (
          <textarea
            ref={field as React.RefObject<HTMLTextAreaElement>}
            className="matter-body"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={keys}
          />
        ) : (
          <input
            ref={field as React.RefObject<HTMLInputElement>}
            className="name-field"
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={keys}
          />
        )}
        {note && <p className="name-path">{note}</p>}
        <div className="matter-foot">
          <span>{multiline ? "⌘⏎ confirm" : "⏎ confirm"} · esc cancel</span>
          <button className="act" onClick={submit} disabled={!value.trim()}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
