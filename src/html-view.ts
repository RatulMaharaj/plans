/**
 * Rendering the HTML that markdown files contain.
 *
 * Milkdown keeps HTML as an atom node whose DOM is the raw source text, so a
 * `<picture>` block or an `<!-- aside -->` shows up as literal characters in
 * the middle of the prose. This replaces that view with two behaviours:
 *
 *   - comments become a quiet margin marker that opens the comment on click;
 *   - everything else is rendered, with relative image paths resolved against
 *     the repository so a README cover actually appears.
 *
 * The markdown itself is untouched either way — the node still serialises back
 * to exactly the source it came from.
 */
import { $prose, $view } from "@milkdown/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { htmlSchema } from "@milkdown/preset-commonmark";
import { api } from "./api";

const COMMENT = /^\s*<!--([\s\S]*?)-->\s*$/;

/** Author written into the comment as `@name`, if there is one. */
export function commentAuthor(body: string): string | null {
  return body.match(/@([A-Za-z0-9_.-]+)/)?.[1] ?? null;
}

/**
 * A thread is one comment with more than one voice in it: one line per turn,
 * each "@name: what they said". The strict reading — *every* non-empty line
 * must match — is what keeps prose that merely mentions an @handle rendering
 * as the single comment it is.
 */
export type CommentTurn = { who: string | null; text: string };

export function commentTurns(body: string): CommentTurn[] {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = lines.map((l) => l.match(/^@([A-Za-z0-9_.-]+):\s*(.*)$/));
  if (lines.length > 0 && parsed.every(Boolean)) {
    return parsed.map((m) => ({ who: m![1], text: m![2] }));
  }
  return [{ who: commentAuthor(body), text: body }];
}

/** `@name` fit for a comment: "Ratul Maharaj" becomes "ratul-maharaj". */
export function authorSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "");
}

/**
 * A reply appended to a comment's source. The first reply promotes a one-line
 * comment to the block form — one line per turn — which is also how a person
 * would write it by hand.
 */
export function withReply(value: string, author: string, text: string): string {
  const body = value.match(COMMENT)?.[1] ?? "";
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const reply = author ? `@${author}: ${text}` : text;
  return `<!--\n${[...lines, reply].join("\n")}\n-->`;
}

/**
 * The comment card, shared between the two ways a comment can arrive: as one
 * node (a single-line comment, or anything the app itself wrote) rendered by
 * the node view, and as a run of per-line nodes gathered by the decoration
 * plugin below. `replace` writes the whole comment back — the reply field goes
 * through it, so both arrivals get threads for free.
 */
function commentCard(
  value: string,
  replace: (next: string) => void,
): { dom: HTMLElement; destroy: () => void } {
  const body = (value.match(COMMENT)?.[1] ?? value).trim();
  const turns = commentTurns(body);

  const dom = document.createElement("span");
  dom.className = "md-comment";
  dom.setAttribute("data-type", "html");
  dom.setAttribute("data-value", value);

  const mark = document.createElement("button");
  mark.className = "md-comment-mark";
  mark.type = "button";
  mark.textContent = turns.length > 1 ? `comment +${turns.length}` : "comment";
  mark.title = body;

  const card = document.createElement("span");
  card.className = "md-comment-card";
  for (const t of turns) {
    const turn = document.createElement("span");
    turn.className = "md-comment-turn";
    const meta = document.createElement("span");
    meta.className = "md-comment-who";
    meta.textContent = t.who ? `@${t.who}` : "comment";
    const text = document.createElement("span");
    text.className = "md-comment-text";
    text.textContent = t.text;
    turn.append(meta, text);
    card.appendChild(turn);
  }

  // The reply lands in the file, not in an inbox: one more line in the block.
  const reply = document.createElement("span");
  reply.className = "md-comment-reply";
  const field = document.createElement("input");
  field.type = "text";
  field.placeholder = htmlContext.author ? `Reply as @${htmlContext.author}` : "Reply";
  field.className = "md-comment-field";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "md-comment-send";
  send.textContent = "Reply";
  const submit = () => {
    const text = field.value.trim();
    if (!text) return;
    replace(withReply(value, htmlContext.author, text));
  };
  send.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    submit();
  });
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") close();
  });
  // The field is inside the editor's DOM; without these the keystrokes would
  // be ProseMirror's, and a click would move the caret instead of the focus.
  for (const ev of ["mousedown", "beforeinput", "paste", "cut"] as const) {
    field.addEventListener(ev, (e) => e.stopPropagation());
  }
  reply.append(field, send);
  card.appendChild(reply);

  // One card open at a time, and any click elsewhere puts it away.
  const away = (e: MouseEvent) => {
    if (!dom.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close() {
    dom.classList.remove("open");
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("keydown", onKey, true);
  }

  mark.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dom.classList.contains("open")) return close();
    document.querySelectorAll(".md-comment.open").forEach((el) => el.classList.remove("open"));
    dom.classList.add("open");
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", onKey, true);
  });
  dom.append(mark, card);
  return {
    dom,
    destroy: () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", onKey, true);
    },
  };
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

/**
 * Block HTML arrives as one node per line, not one per element, so a <picture>
 * block is split into "<picture>", "<source …>", "<img …>", "</picture>" —
 * each parsed on its own. A lone <source> is meaningless to the DOM parser and
 * an unclosed <picture> is empty, which is why a remote <img> renders and a
 * <picture> cover does not. Fragments that cannot stand alone are unwrapped:
 * the <source> becomes an <img> so the picture still shows something.
 */
function standalone(html: string): string {
  const t = html.trim();
  // An opening or closing wrapper on its own contributes nothing to render.
  if (/^<\/?(picture|figure|div|p|a|span)\b[^>]*>$/i.test(t)) return "";
  // A <source> outside its <picture>: promote it, so the image is not lost.
  const src = t.match(/^<source\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>$/i);
  if (src) return `<img src="${src[1].split(/[ ,]/)[0]}" />`;
  return html;
}

/**
 * Point relative sources at the repository.
 *
 * Read through Rust as a data URL rather than the asset protocol: that route
 * needs scope configuration and a custom scheme, and in the dev webview the
 * request simply never resolves. These files are already ours to read.
 */
const assets = new Map<string, string>();

function resolveAssets(root: HTMLElement, repo: string, relPath: string) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";

  const fix = (el: Element, attr: string) => {
    const raw = el.getAttribute(attr);
    if (!raw || /^(https?:|data:|blob:|\/\/)/i.test(raw)) return;

    /**
     * Take the attribute off before the browser can act on it. A relative path
     * resolves against the dev server, fails within the same tick, and the
     * error handler below would report a miss before the real bytes arrived.
     */
    el.removeAttribute(attr);
    const rel = raw.startsWith("/") ? raw.slice(1) : dir ? `${dir}/${raw}` : raw;
    const key = `${repo}::${rel}`;

    const miss = (why: string) => {
      const note = document.createElement("span");
      note.className = "md-html-missing";
      note.textContent = `image did not load — ${rel} (${why})`;
      el.replaceWith(note);
    };

    if (!repo) return miss("no repository");

    const hit = assets.get(key);
    if (hit) return el.setAttribute(attr, hit);

    void api.readAsset(repo, rel).then(
      (url) => {
        assets.set(key, url);
        el.setAttribute(attr, url);
      },
      (e) => miss(String(e).replace(/^Error:\s*/, "")),
    );
  };

  root.querySelectorAll("img").forEach((el) => fix(el, "src"));
  root.querySelectorAll("source").forEach((el) => fix(el, "srcset"));
}

/**
 * The view needs to know which file it is in to resolve relative paths, and
 * that isn't in the node — so it is set here whenever a document is opened.
 */
export const htmlContext = { repo: "", relPath: "", author: "" };

/**
 * The bridge between rendered HTML and the app.
 *
 * A node view cannot open a React sheet, and React cannot dispatch a ProseMirror
 * transaction, so each side registers what it can do: App opens the editor,
 * Editor applies the result. Everything HTML — a picture, a div, a comment —
 * goes through the same two calls, rather than growing its own affordance.
 */
export type HtmlEdit = { from: number; to: number; value: string };

export const htmlBridge: {
  /** Set by App: show the raw fragment for editing. */
  request: ((edit: HtmlEdit) => void) | null;
  /** Set by Editor: write the fragment back into the document. */
  apply: ((edit: HtmlEdit) => void) | null;
  /** Set by Editor: put a new fragment in at the cursor. */
  insert: ((value: string) => void) | null;
  /**
   * Set by Editor: put a comment in after the block holding the selection —
   * never inline, where it would split a sentence in the source.
   */
  comment: ((value: string) => void) | null;
  /** Set by Editor: put the cursor at the end of the document and focus it. */
  focusEnd: (() => void) | null;
  /**
   * Set by App: focus the document the editor puts up next, once.
   *
   * A flag rather than a call, because App has nothing to call yet. Opening a
   * file only *requests* the state change that leads to the editor swapping its
   * document — so focusing at the point of asking lands the cursor in the file
   * you were reading before, which the swap then throws away. The request is
   * left here and honoured on the other side, once the new document has
   * settled. One-shot: the file opened after a created one must not inherit it.
   */
  focusNext: boolean;
} = { request: null, apply: null, insert: null, comment: null, focusEnd: null, focusNext: false };

/** Whether a fragment is one complete comment, fences and all. */
export function isComment(value: string): boolean {
  return COMMENT.test(value);
}

export const htmlView = $view(htmlSchema.node, () => (node, _view, getPos, decorations) => {
  const edit = () =>
    htmlBridge.request?.({
      from: getPos() ?? 0,
      to: (getPos() ?? 0) + node.nodeSize,
      value: String(node.attrs.value ?? ""),
    });
  const value = String(node.attrs.value ?? "");
  const comment = value.match(COMMENT);

  if (comment) {
    const { dom, destroy } = commentCard(value, (next) =>
      htmlBridge.apply?.({
        from: getPos() ?? 0,
        to: (getPos() ?? 0) + node.nodeSize,
        value: next,
      }),
    );
    for (const d of decorations ?? []) {
      const cls = (d as unknown as { type?: { attrs?: { class?: string } } }).type?.attrs?.class;
      if (cls) dom.classList.add(...cls.split(" "));
    }
    return {
      dom,
      ignoreMutation: () => true,
      stopEvent: () => true,
      destroy,
    };
  }

  const dom = document.createElement("span");
  dom.className = "md-html";
  /**
   * ProseMirror does not put inline decorations on an atom's DOM — it hands
   * them to the node view instead. Without this the classes the wrapper plugin
   * computes never land, and a hidden tag stays visible.
   */
  for (const d of decorations ?? []) {
    const cls = (d as unknown as { type?: { attrs?: { class?: string } } }).type?.attrs?.class;
    if (cls) dom.classList.add(...cls.split(" "));
  }
  dom.setAttribute("data-type", "html");
  dom.setAttribute("data-value", value);
  dom.innerHTML = sanitize(standalone(value));
  resolveAssets(dom, htmlContext.repo, htmlContext.relPath);
  dom.title = "Double-click to edit the HTML";
  dom.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    edit();
  });
  return { dom, ignoreMutation: () => true, stopEvent: () => true };
});

/* ===========================================================================
   <picture>, chosen by the app's paper rather than the system.
   ---------------------------------------------------------------------------
   Block HTML arrives as one node per line, so a picture is a run of nodes:
   the opening tag, its sources, a fallback img, the closing tag. Rendering
   them separately gives one image per source — and the media queries would be
   answered by macOS's appearance anyway, not by the paper in this app.

   So the run is collected, hidden, and replaced by a single widget holding
   whichever source matches the current theme.
   =========================================================================== */

type HtmlState = { signature: string; set: DecorationSet };

const pictureKey = new PluginKey<HtmlState>("plans-picture");

/**
 * Every html node's text, joined. Cheap next to parsing them.
 *
 * Held in the plugin's own state, never in a module variable: an editor can be
 * built twice (React remounts, StrictMode does it deliberately), and a shared
 * signature means the second instance compares against the first's work,
 * concludes nothing has changed, and renders no decorations at all.
 */
function htmlSignature(doc: PMNode): string {
  const parts: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "html") parts.push(String(node.attrs.value ?? ""));
  });
  return parts.join("\u0000");
}

/**
 * Night is the only dark paper. Sepia is warm, not dark — it answers "light",
 * as Day does, so a README cover picks its light artwork on both.
 */
const DARK_PAPERS = new Set(["night"]);

function prefersDark(): boolean {
  return DARK_PAPERS.has(document.documentElement.dataset.theme ?? "");
}

/** The source a browser would pick, decided against the app's paper instead. */
function chooseSource(fragment: string): string | null {
  const dark = prefersDark();
  const doc = new DOMParser().parseFromString(
    fragment.includes("<picture") ? fragment : `<picture>${fragment}</picture>`,
    "text/html",
  );
  const sources = [...doc.querySelectorAll("source")];
  const matching = sources.find((el) => {
    const media = (el.getAttribute("media") ?? "").toLowerCase();
    if (!media.includes("prefers-color-scheme")) return false;
    return media.includes("dark") === dark;
  });
  const pick =
    matching?.getAttribute("srcset") ??
    // No media queries: first source wins, as a browser would do.
    sources.find((el) => !el.getAttribute("media"))?.getAttribute("srcset") ??
    doc.querySelector("img")?.getAttribute("src") ??
    null;
  return pick ? pick.split(/[ ,]/)[0] : null;
}

type Run = { from: number; to: number; html: string; blocks: [number, number][] };

/** One html node's worth of text, wherever it sits in the document. */
type Chunk = { value: string; from: number; to: number; block: [number, number] };

/**
 * Every html node in document order, with the block that holds it.
 *
 * A <picture> written across several lines may arrive as several inline nodes
 * in one paragraph, or as one node per block — remark decides, and it varies
 * with the surrounding blank lines. Collecting them flat means the run is found
 * either way; the earlier version only looked inside a single paragraph and so
 * never matched the common case.
 */
function htmlChunks(doc: PMNode): Chunk[] {
  const out: Chunk[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name !== "html") return;
    let block: [number, number] = [pos, pos + node.nodeSize];
    if (parent?.isTextblock) {
      // The enclosing block, so a line of its own can be hidden whole.
      const before = pos - 1 - (index > 0 ? 0 : 0);
      block = [before, before + parent.nodeSize];
    }
    out.push({
      value: String(node.attrs.value ?? ""),
      from: pos,
      to: pos + node.nodeSize,
      block,
    });
  });
  return out;
}

/**
 * Multi-line comments, gathered the way pictures are.
 *
 * A thread written across several lines arrives as one node per line — "<!--",
 * a turn each, "-->" — and none of them alone is a comment the node view can
 * recognise. The run is collected, its lines hidden, and one card widget stands
 * in for the whole block. Single-line comments never open a run here; the node
 * view above already renders them.
 */
function commentRuns(doc: PMNode): Run[] {
  const runs: Run[] = [];
  let open: { from: number; parts: string[]; blocks: [number, number][] } | null = null;
  for (const c of htmlChunks(doc)) {
    const v = c.value.trim();
    if (!open && /^<!--/.test(v) && !v.includes("-->")) {
      open = { from: c.from, parts: [c.value], blocks: [c.block] };
      continue;
    }
    if (open) {
      open.parts.push(c.value);
      open.blocks.push(c.block);
      if (c.value.includes("-->")) {
        runs.push({
          from: open.from,
          to: c.to,
          html: open.parts.join("\n"),
          blocks: open.blocks,
        });
        open = null;
      }
    }
  }
  return runs;
}

function pictureRuns(doc: PMNode): Run[] {
  const runs: Run[] = [];
  let open: { from: number; parts: string[]; blocks: [number, number][] } | null = null;
  for (const c of htmlChunks(doc)) {
    if (/<picture\b/i.test(c.value)) {
      open = { from: c.from, parts: [c.value], blocks: [c.block] };
    } else if (open) {
      open.parts.push(c.value);
      open.blocks.push(c.block);
    }
    if (open && /<\/picture>/i.test(c.value)) {
      runs.push({
        from: open.from,
        to: c.to,
        html: open.parts.join("\n"),
        blocks: open.blocks,
      });
      open = null;
    }
  }
  return runs;
}

/**
 * Wrapper tags and the content between them.
 *
 * `<div align="center">`, `<sub>`, `<b>` and friends arrive as their own nodes,
 * separate from what they wrap — the text between is ordinary markdown. Alone
 * each tag parses to an empty element, so the wrapping is simply lost. Pairing
 * them and decorating the range restores the intent without touching the file.
 */
const INLINE_TAGS = new Set([
  "sub", "sup", "b", "strong", "i", "em", "u", "s", "small", "kbd", "mark", "cite",
]);
const BLOCK_TAGS = new Set(["div", "p", "center", "section", "figure"]);

function wrapperDecorations(doc: PMNode): Decoration[] {
  const out: Decoration[] = [];
  const stack: { tag: string; attrs: string; to: number }[] = [];

  for (const c of htmlChunks(doc)) {
    const v = c.value.trim();
    if (/^<!--/.test(v) || /<picture\b|<\/picture>/i.test(v)) continue;

    const open = v.match(/^<([a-zA-Z][\w-]*)((?:\s[^>]*)?)>$/);
    const close = v.match(/^<\/([a-zA-Z][\w-]*)>$/);
    const selfClosing = /\/>$/.test(v);

    if (open && !selfClosing && (INLINE_TAGS.has(open[1].toLowerCase()) || BLOCK_TAGS.has(open[1].toLowerCase()))) {
      stack.push({ tag: open[1].toLowerCase(), attrs: open[2] ?? "", to: c.to });
      out.push(Decoration.inline(c.from, c.to, { class: "md-hidden" }));
      continue;
    }

    if (close) {
      const tag = close[1].toLowerCase();
      const i = stack.map((s) => s.tag).lastIndexOf(tag);
      if (i === -1) continue;
      const opened = stack[i];
      stack.length = i;
      out.push(Decoration.inline(c.from, c.to, { class: "md-hidden" }));
      if (opened.to >= c.from) continue;

      if (INLINE_TAGS.has(tag)) {
        out.push(Decoration.inline(opened.to, c.from, { class: `md-i md-i-${tag}` }));
      } else {
        // Blocks take a class of their own, since alignment is not inheritable
        // through an inline decoration.
        const centred =
          /align\s*=\s*["']?center/i.test(opened.attrs) ||
          /text-align\s*:\s*center/i.test(opened.attrs);
        if (!centred) continue;
        doc.nodesBetween(opened.to, c.from, (node, pos) => {
          if (!node.isBlock || node.isTextblock === false) return;
          if (pos < opened.to || pos + node.nodeSize > c.from) return;
          out.push(Decoration.node(pos, pos + node.nodeSize, { class: "md-center" }));
          return false;
        });
      }
    }
  }
  return out;
}

function pictureDecorations(doc: PMNode, repo: string, relPath: string): DecorationSet {
  const out: Decoration[] = wrapperDecorations(doc);
  for (const run of commentRuns(doc)) {
    const seen = new Set<string>();
    for (const [from, to] of run.blocks) {
      const key = `${from}:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Decoration.inline(from, to, { class: "md-hidden" }));
    }
    let card: { dom: HTMLElement; destroy: () => void } | null = null;
    out.push(
      Decoration.widget(
        run.to,
        () => {
          card = commentCard(run.html, (next) =>
            htmlBridge.apply?.({ from: run.from, to: run.to, value: next }),
          );
          card.dom.setAttribute("contenteditable", "false");
          return card.dom;
        },
        {
          side: 1,
          key: `comment:${run.from}:${run.html}`,
          destroy: () => card?.destroy(),
        },
      ),
    );
  }
  for (const run of pictureRuns(doc)) {
    const src = chooseSource(run.html);
    // Hide each block the run occupies, so no empty paragraphs are left behind.
    const seen = new Set<string>();
    for (const [from, to] of run.blocks) {
      const key = `${from}:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Decoration.inline(from, to, { class: "md-hidden" }));
    }
    if (!src) continue;
    out.push(
      Decoration.widget(
        run.to,
        () => {
          const host = document.createElement("span");
          host.className = "md-html";
          host.setAttribute("contenteditable", "false");
          const img = document.createElement("img");
          img.alt = "";
          // Which paper chose this, so a wrong pick is diagnosable on sight.
          img.title = `${prefersDark() ? "dark" : "light"} · ${src}`;
          // Set through resolveAssets, never directly: a relative src would be
          // attempted against the dev server and fail before the bytes land.
          img.setAttribute("src", src);
          host.appendChild(img);
          resolveAssets(host, repo, relPath);
          host.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            htmlBridge.request?.({ from: run.from, to: run.to, value: run.html });
          });
          return host;
        },
        { side: 1, key: `picture:${run.from}:${src}:${prefersDark()}` },
      ),
    );
  }
  return DecorationSet.create(doc, out);
}

export const pictureView = $prose(
  () =>
    new Plugin({
      key: pictureKey,
      state: {
        init: (_, state) => ({
          signature: htmlSignature(state.doc),
          set: pictureDecorations(state.doc, htmlContext.repo, htmlContext.relPath),
        }),
        /**
         * Rebuild only when the HTML in the document changed, or when the paper
         * did. Every other transaction moves the existing decorations along —
         * scanning the document and running DOMParser on each keystroke was a
         * large part of why typing dragged.
         */
        apply(tr, old) {
          if (tr.getMeta(pictureKey)) {
            return {
              signature: htmlSignature(tr.doc),
              set: pictureDecorations(tr.doc, htmlContext.repo, htmlContext.relPath),
            };
          }
          if (!tr.docChanged) return old;
          const now = htmlSignature(tr.doc);

          /**
           * Mapping is the cheap path, but it is not always enough.
           *
           * Loading or swapping a document replaces the whole doc, and mapping
           * decorations through that deletion drops all of them. The signature
           * is unchanged — same HTML, different document — so a signature check
           * alone would keep an empty set and render nothing. Counting what
           * survived catches it.
           */
          const mapped = old.set.map(tr.mapping, tr.doc);
          const intact = mapped.find().length === old.set.find().length;
          if (now === old.signature && intact) return { signature: now, set: mapped };

          return {
            signature: now,
            set: pictureDecorations(tr.doc, htmlContext.repo, htmlContext.relPath),
          };
        },
      },
      props: {
        // Through the key: `this` is not reliably the plugin once Milkdown has
        // wrapped it, and a decoration set that is never returned is invisible.
        // Through the key: `this` is not reliably the plugin once Milkdown has
        // wrapped it.
        decorations: (state) => pictureKey.getState(state)?.set,
      },
      // The choice depends on the paper, so changing it re-decides.
      view: (view: EditorView) => {
        const observer = new MutationObserver(() =>
          view.dispatch(view.state.tr.setMeta(pictureKey, true)),
        );
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        return { destroy: () => observer.disconnect() };
      },
    }),
);
