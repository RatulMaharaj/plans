/**
 * Mermaid diagrams, drawn under their source.
 *
 * The code block itself is left alone — it stays a CodeMirror instance you can
 * type in — and the picture is a widget decoration placed after it. So the
 * source remains the document, the diagram is a view of it, and nothing about
 * the markdown on disk changes.
 *
 * Rendering is async and debounced: a half-typed diagram is a syntax error most
 * of the time, and re-rendering on every keystroke would flash.
 */
import { $prose } from "@milkdown/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import mermaid from "mermaid";

type MermaidState = { signature: string; set: DecorationSet };

const key = new PluginKey<MermaidState>("plans-mermaid");

/** Rendered SVG by diagram source, so scrolling doesn't re-render the world. */
const cache = new Map<string, string>();
let seq = 0;
let themed = "";

/** Mermaid takes concrete colours, so the tokens are resolved at render time. */
function applyTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  const signature = `${v("--paper")}${v("--ink")}`;
  if (signature === themed) return;
  themed = signature;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    fontFamily: v("--mono") || "monospace",
    theme: "base",
    themeVariables: {
      background: v("--paper"),
      primaryColor: v("--shade"),
      primaryTextColor: v("--ink"),
      primaryBorderColor: v("--rule-strong"),
      secondaryColor: v("--raised"),
      tertiaryColor: v("--paper"),
      lineColor: v("--ink-3"),
      textColor: v("--ink-2"),
      mainBkg: v("--shade"),
      nodeBorder: v("--rule-strong"),
      clusterBkg: v("--paper"),
      clusterBorder: v("--rule"),
      titleColor: v("--ink"),
      edgeLabelBackground: v("--paper"),
    },
  });
}

function isMermaid(node: PMNode): boolean {
  if (node.type.name !== "code_block") return false;
  const lang = String(node.attrs.language ?? "").toLowerCase();
  return lang === "mermaid";
}

/**
 * Mermaid stamps a fixed width/height and an inline max-width on its SVG, sized
 * for the viewport it happened to render in. Left alone the diagram is cropped
 * — so the intrinsic size is dropped and the viewBox is left to scale it.
 */
function fit(host: HTMLElement) {
  const svg = host.querySelector("svg");
  if (!svg) return;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.removeProperty("max-width");
  svg.style.width = "100%";
  svg.style.height = "auto";
  svg.style.maxWidth = "100%";
  svg.style.display = "block";
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

/** Draw into an existing element; failures show the message, not a blank box. */
async function draw(host: HTMLElement, source: string) {
  const hit = cache.get(source);
  if (hit) {
    host.innerHTML = hit;
    host.classList.remove("bad");
    fit(host);
    return;
  }
  applyTheme();
  try {
    const { svg } = await mermaid.render(`plans-mermaid-${seq++}`, source);
    cache.set(source, svg);
    host.innerHTML = svg;
    host.classList.remove("bad");
    fit(host);
  } catch (e) {
    host.classList.add("bad");
    host.textContent = String(e instanceof Error ? e.message : e).split("\n")[0];
  }
}

/** The diagrams' sources, joined — cheap to compute, and enough to compare. */
function signature(doc: PMNode): string {
  const parts: string[] = [];
  doc.descendants((node) => {
    if (isMermaid(node)) parts.push(node.textContent);
  });
  return parts.join("\u0000");
}

function build(doc: PMNode): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!isMermaid(node)) return;
    const source = node.textContent.trim();
    if (!source) return;
    out.push(
      Decoration.widget(
        pos + node.nodeSize,
        () => {
          const host = document.createElement("div");
          host.className = "mermaid-figure";
          host.setAttribute("contenteditable", "false");
          void draw(host, source);
          return host;
        },
        // Keyed by source so an unchanged diagram is not rebuilt on every
        // transaction; editing the block replaces the widget instead.
        { side: 1, key: `mermaid:${pos}:${source}` },
      ),
    );
  });
  return DecorationSet.create(doc, out);
}

export const mermaidView = $prose(
  () =>
    new Plugin({
      key,
      state: {
        // Signature in the plugin's state, not a module variable: two editors
        // would otherwise share it, and the second would render nothing.
        init: (_, state) => ({ signature: signature(state.doc), set: build(state.doc) }),
        /**
         * Only rebuild when a diagram's own text changed. Otherwise the old
         * decorations are moved to their new positions, which is what
         * ProseMirror provides mapping for — rebuilding on every keystroke
         * meant a full document scan and a fresh widget per diagram per key.
         */
        apply(tr, old) {
          if (tr.getMeta(key)) {
            return { signature: signature(tr.doc), set: build(tr.doc) };
          }
          if (!tr.docChanged) return old;
          const now = signature(tr.doc);
          // Mapping through a whole-document replacement drops everything, and
          // the signature cannot tell that apart from an ordinary edit.
          const mapped = old.set.map(tr.mapping, tr.doc);
          const intact = mapped.find().length === old.set.find().length;
          if (now === old.signature && intact) return { signature: now, set: mapped };
          return { signature: now, set: build(tr.doc) };
        },
      },
      props: {
        // Through the key: `this` is not reliably the plugin here.
        decorations: (state) => key.getState(state)?.set,
      },
      /**
       * Repaint when the paper changes.
       *
       * This must not be done from the plugin's update hook: dispatching there
       * runs the update cycle again, which dispatches again — an unbounded
       * recursion that ends in "Maximum call stack size exceeded" and takes the
       * window with it. Watching the attribute instead means the transaction
       * starts from outside the cycle, once per actual change.
       */
      view: (view: EditorView) => {
        const repaint = () => {
          cache.clear();
          themed = "";
          view.dispatch(view.state.tr.setMeta(key, true));
        };
        const observer = new MutationObserver(repaint);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        return { destroy: () => observer.disconnect() };
      },
    }),
);
