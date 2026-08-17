/**
 * Rendering the HTML that markdown files contain.
 *
 * Milkdown keeps HTML as an atom node whose DOM is the raw source text, so a
 * `<picture>` block or an `<!-- aside -->` shows up as literal characters in
 * the middle of the prose. This replaces that view with two behaviours:
 *
 *   - comments become a quiet margin marker that opens the note on click;
 *   - everything else is rendered, with relative image paths resolved against
 *     the repository so a README cover actually appears.
 *
 * The markdown itself is untouched either way — the node still serialises back
 * to exactly the source it came from.
 */
import { $view } from "@milkdown/utils";
import { htmlSchema } from "@milkdown/preset-commonmark";
import { convertFileSrc } from "@tauri-apps/api/core";

const COMMENT = /^\s*<!--([\s\S]*?)-->\s*$/;

/** Author written into the comment as `@name`, if there is one. */
export function commentAuthor(body: string): string | null {
  return body.match(/@([A-Za-z0-9_.-]+)/)?.[1] ?? null;
}

/**
 * These files are the reader's own, but they are also written by agents, and a
 * script tag in a plan should never run just because the plan was opened.
 */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, link, meta, style").forEach((n) =>
    n.remove(),
  );
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || (n === "href" && a.value.trim().toLowerCase().startsWith("javascript:"))) {
        el.removeAttribute(a.name);
      }
    }
  });
  return doc.body.innerHTML;
}

/** Point relative sources at the repository, through Tauri's asset protocol. */
function resolveAssets(root: HTMLElement, repo: string, relPath: string) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const fix = (el: Element, attr: string) => {
    const raw = el.getAttribute(attr);
    if (!raw || /^(https?:|data:|asset:|blob:|\/\/)/i.test(raw)) return;
    const rel = raw.startsWith("/") ? raw.slice(1) : dir ? `${dir}/${raw}` : raw;
    try {
      el.setAttribute(attr, convertFileSrc(`${repo}/${rel}`));
    } catch {
      /* leave it alone rather than break the render */
    }
  };
  root.querySelectorAll("img").forEach((el) => fix(el, "src"));
  root.querySelectorAll("source").forEach((el) => fix(el, "srcset"));
}

/**
 * The view needs to know which file it is in to resolve relative paths, and
 * that isn't in the node — so it is set here whenever a document is opened.
 */
export const htmlContext = { repo: "", relPath: "" };

export const htmlView = $view(htmlSchema.node, () => (node) => {
  const value = String(node.attrs.value ?? "");
  const comment = value.match(COMMENT);

  if (comment) {
    const body = comment[1].trim();
    const who = commentAuthor(body);
    const dom = document.createElement("span");
    dom.className = "md-comment";
    dom.setAttribute("data-type", "html");
    dom.setAttribute("data-value", value);

    const mark = document.createElement("button");
    mark.className = "md-comment-mark";
    mark.type = "button";
    mark.textContent = "note";
    mark.title = body;

    const card = document.createElement("span");
    card.className = "md-comment-card";
    const meta = document.createElement("span");
    meta.className = "md-comment-who";
    meta.textContent = who ? `@${who}` : "comment";
    const text = document.createElement("span");
    text.className = "md-comment-text";
    text.textContent = body;
    card.append(meta, text);

    mark.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.classList.toggle("open");
    });
    dom.append(mark, card);
    return { dom, ignoreMutation: () => true, stopEvent: () => true };
  }

  const dom = document.createElement("span");
  dom.className = "md-html";
  dom.setAttribute("data-type", "html");
  dom.setAttribute("data-value", value);
  dom.innerHTML = sanitize(value);
  resolveAssets(dom, htmlContext.repo, htmlContext.relPath);
  return { dom, ignoreMutation: () => true, stopEvent: () => true };
});
