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

const key = new PluginKey("plans-mermaid");

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
        init: (_, state) => build(state.doc),
        apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
      },
      props: {
        decorations(this: Plugin, state) {
          return this.getState(state);
        },
      },
      view: () => ({
        // Re-render when the paper changes, since the colours are baked in.
        update: (view: EditorView) => {
          const s = getComputedStyle(document.documentElement);
          if (`${s.getPropertyValue("--paper").trim()}${s.getPropertyValue("--ink").trim()}` !== themed) {
            cache.clear();
            view.dispatch(view.state.tr.setMeta("plans-mermaid-repaint", true));
          }
        },
      }),
    }),
);
