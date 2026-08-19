/**
 * A dropdown in the app's own voice.
 *
 * Native <select> renders in system chrome — grey, rounded, and indifferent to
 * the paper you've chosen — so this replaces it. Same keyboard behaviour as the
 * real thing: arrows move, enter picks, escape closes, typing jumps.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type Choice = {
  value: string;
  label: string;
  /** Dim text on the right of the row — a branch, a note, a count. */
  note?: string;
  /** Set apart under a rule, for "Add a repository…" and its kind. */
  apart?: boolean;
};

type Props = {
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Extra class on the trigger, for the two call sites' different sizes. */
  className?: string;
  /** Shown when the value matches no choice. */
  placeholder?: string;
  /** Called as the menu opens, for choices that are expensive to have ready. */
  onOpen?: () => void;
};

export function Dropdown({
  value,
  choices,
  onChange,
  disabled,
  ariaLabel,
  className = "",
  placeholder = "—",
  onOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ buf: "", at: 0 });
  const [drop, setDrop] = useState<"down" | "up">("down");

  const current = choices.find((c) => c.value === value);

  useEffect(() => {
    if (!open) return;
    setSel(Math.max(0, choices.findIndex((c) => c.value === value)));
  }, [open, choices, value]);

  // Flip above the trigger when there isn't room below it.
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    setDrop(window.innerHeight - r.bottom < 240 && r.top > 240 ? "up" : "down");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: "nearest" });
  }, [open, sel]);

  const pick = (i: number) => {
    const c = choices[i];
    setOpen(false);
    if (c && c.value !== value) onChange(c.value);
    else if (c?.apart) onChange(c.value);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        onOpen?.();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => (i + 1) % choices.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => (i - 1 + choices.length) % choices.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setSel(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setSel(choices.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(sel);
    } else if (e.key.length === 1) {
      // Type-ahead, the way a real select behaves.
      const now = performance.now();
      const t = typed.current;
      t.buf = now - t.at > 700 ? e.key : t.buf + e.key;
      t.at = now;
      const hit = choices.findIndex((c) => c.label.toLowerCase().startsWith(t.buf.toLowerCase()));
      if (hit !== -1) setSel(hit);
    }
  };

  return (
    <div className={`dd ${className} ${open ? "open" : ""}`} ref={wrap}>
      <button
        type="button"
        className="dd-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((o) => !o);
        }}
        onKeyDown={onKey}
      >
        <span className="dd-value">{current?.label ?? placeholder}</span>
        <span className="dd-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className={`dd-menu ${drop === "up" ? "up" : ""}`} role="listbox" ref={menu}>
          {choices.map((c, i) => (
            <button
              type="button"
              key={c.value}
              role="option"
              aria-selected={c.value === value}
              data-on={i === sel ? "1" : "0"}
              className={`dd-item ${i === sel ? "on" : ""} ${c.apart ? "apart" : ""}`}
              onMouseMove={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <span className="dd-tick" aria-hidden>
                {c.value === value ? "·" : ""}
              </span>
              <span className="dd-label">{c.label}</span>
              {c.note && <span className="dd-note">{c.note}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
