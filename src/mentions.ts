/**
 * `@` completes to a member's handle.
 *
 * Nothing happens to a mention beyond this: the app has no inbox, so `@bob`
 * in a comment is a name and a name only. What the completion buys is that
 * the name is spelled the way the server knows it. Plain DOM, because one
 * of the two fields it serves is the comment card's reply box, which lives
 * inside ProseMirror's tree and is not React's.
 */

/** Handles, asked for at the moment the menu opens, so a late list still counts. */
export type Handles = () => string[];

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The `@word` the caret is at the end of, if any. */
function mentionAt(field: Field): { start: number; query: string } | null {
  const caret = field.selectionStart ?? field.value.length;
  const before = field.value.slice(0, caret);
  const m = before.match(/(^|\s)@([A-Za-z0-9_.-]*)$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function attachMentions(field: Field, handles: Handles): () => void {
  const menu = document.createElement("div");
  menu.className = "mentions";
  menu.setAttribute("role", "listbox");
  let items: string[] = [];
  let index = 0;
  let at: { start: number; query: string } | null = null;

  const close = () => {
    at = null;
    items = [];
    menu.remove();
  };

  const draw = () => {
    menu.replaceChildren();
    items.forEach((h, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `mentions-item${i === index ? " on" : ""}`;
      row.textContent = `@${h}`;
      row.setAttribute("role", "option");
      // mousedown, so the field keeps its focus and the caret its place.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pick(h);
      });
      menu.appendChild(row);
    });
    if (!menu.isConnected) {
      // Under the field, in the field's own stacking context.
      const host = field.parentElement ?? document.body;
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(menu);
    }
    menu.style.left = `${field.offsetLeft}px`;
    menu.style.top = `${field.offsetTop + field.offsetHeight + 4}px`;
  };

  const pick = (handle: string) => {
    if (!at) return;
    const caret = field.selectionStart ?? field.value.length;
    const next = `${field.value.slice(0, at.start)}@${handle} ${field.value.slice(caret)}`;
    const place = at.start + handle.length + 2;
    // Through the native setter, so a React-controlled field sees the change.
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, next);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.setSelectionRange(place, place);
    close();
  };

  const look = () => {
    at = mentionAt(field);
    if (!at) return close();
    const q = at.query.toLowerCase();
    items = handles().filter((h) => h.toLowerCase().startsWith(q));
    if (items.length === 0) return close();
    index = Math.min(index, items.length - 1);
    draw();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!at || items.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = (index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      // The field's own Enter would send the reply; the menu answers first.
      e.stopImmediatePropagation();
      pick(items[index]);
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      close();
    }
  };

  const onInput = () => {
    index = 0;
    look();
  };

  // Capture, so the choice is made before the field's own Enter submits.
  const el: HTMLElement = field;
  el.addEventListener("keydown", onKey, true);
  el.addEventListener("input", onInput);
  el.addEventListener("blur", close);
  return () => {
    el.removeEventListener("keydown", onKey, true);
    el.removeEventListener("input", onInput);
    el.removeEventListener("blur", close);
    close();
  };
}
