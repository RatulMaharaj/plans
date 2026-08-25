/**
 * A dropdown in the app's own voice.
 *
 * Native <select> renders in system chrome — grey, rounded, and indifferent to
 * the paper you've chosen — so this replaces it. Same keyboard behaviour as the
 * real thing: arrows move, enter picks, escape closes, typing jumps.
 *
 * Past a certain length the type-ahead a real select taught everyone stops
 * being enough — a prefix match against two hundred branch names that all
 * begin `plans/` finds nothing — so the menu grows a filter field instead,
 * scored by the same matcher the palette uses. The component decides that from
 * `choices.length`: any list that *could* be long gets search, because a call
 * site cannot know which of its lists will be.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { score } from "./score";

export type Choice = {
  value: string;
  label: string;
  /** Dim text on the right of the row — a branch, a note, a count. */
  note?: string;
  /** Set apart under a rule, for "Add a repository…" and its kind. */
  apart?: boolean;
  /**
   * Never filtered away. For rows that are an action rather than a choice —
   * "Add a repository…" is the answer to a search that found nothing, so it
   * cannot be one of the things the search removes.
   */
  always?: boolean;
};

/**
 * Where a menu stops being a glance and starts being a scroll. Ten is by feel
 * across the lists this actually bites: three papers stay a plain menu, a
 * repository's folders and an agent's models are already past it.
 */
export const FILTER_AT = 10;

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
  /**
   * A quiet line under the menu's top, for a list that is still arriving. The
   * stale choices stay usable while it shows — an empty box that fills when
   * git gets around to it is worse than a list one commit out of date.
   */
  status?: string;
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
  status,
}: Props) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const typed = useRef({ buf: "", at: 0 });
  const [drop, setDrop] = useState<"down" | "up">("down");

  const current = choices.find((c) => c.value === value);
  const searchable = choices.length >= FILTER_AT;

  /**
   * What the menu is showing. Unfiltered it is the list as given, in the order
   * the call site meant. Filtered it is the matches by score, with the `apart`
   * rows kept together at the foot so their rule still separates a group
   * rather than falling between two arbitrary rows, and the `always` rows —
   * actions, not choices — surviving the query entirely.
   */
  const shown = useMemo(() => {
    if (!searchable || !query) return choices;
    return [
      ...choices
        .filter((c) => !c.always)
        .map((c) => ({ c, s: score(`${c.label} ${c.note ?? ""}`, query) }))
        .filter((x) => x.s !== null)
        .sort(
          (a, b) => Number(!!a.c.apart) - Number(!!b.c.apart) || (b.s as number) - (a.s as number),
        )
        .map((x) => x.c),
      ...choices.filter((c) => c.always),
    ];
  }, [choices, query, searchable]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
  }, [open]);

  // The selection follows the list: the current value while nothing is typed,
  // the best match once something is.
  useEffect(() => {
    if (!open) return;
    setSel(query ? 0 : Math.max(0, shown.findIndex((c) => c.value === value)));
  }, [open, shown, value, query]);

  useEffect(() => {
    if (open && searchable) field.current?.focus();
  }, [open, searchable]);

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

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const pick = (i: number) => {
    const c = shown[i];
    close();
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
      // The two-step back-out the app practises elsewhere: the filter first,
      // the menu second.
      if (query) setQuery("");
      else close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (shown.length) setSel((i) => (i + 1) % shown.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setSel((i) => (i - 1 + shown.length) % shown.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setSel(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setSel(shown.length - 1);
    } else if (e.key === "Enter" || (e.key === " " && !searchable)) {
      e.preventDefault();
      if (shown.length) pick(sel);
    } else if (e.key.length === 1 && !searchable) {
      // Type-ahead, the way a real select behaves. Above the threshold the
      // filter has taken this job over entirely: one text entry, one meaning.
      const now = performance.now();
      const t = typed.current;
      t.buf = now - t.at > 700 ? e.key : t.buf + e.key;
      t.at = now;
      const hit = shown.findIndex((c) => c.label.toLowerCase().startsWith(t.buf.toLowerCase()));
      if (hit !== -1) setSel(hit);
    }
  };

  return (
    <div className={`dd ${className} ${open ? "open" : ""}`} ref={wrap}>
      <button
        type="button"
        className="dd-trigger"
        ref={trigger}
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
        <div className={`dd-menu ${drop === "up" ? "up" : ""}`} ref={menu}>
          {searchable && (
            <input
              className="dd-filter"
              ref={field}
              type="text"
              value={query}
              spellCheck={false}
              autoComplete="off"
              placeholder="Filter…"
              aria-label={`Filter ${ariaLabel}`}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
            />
          )}
          {status && <div className="dd-status">{status}</div>}
          {/* The trigger carries the name; repeating it here would make one
              control answer to the same label twice. */}
          <div className="dd-list" role="listbox">
            {shown.map((c, i) => (
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
            {!shown.length && <div className="dd-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}
