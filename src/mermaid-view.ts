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

/**
 * Rendered SVG by paper and source, so scrolling doesn't re-render the world.
 *
 * The paper is part of the key rather than something the cache is cleared for:
 * a diagram's colours are baked into its SVG when it is drawn, and an entry
 * drawn for one paper is simply not an answer for another.
 */
const cache = new Map<string, string>();
let seq = 0;
let themed = "";

/**
 * How far each diagram has been zoomed and panned.
 *
 * This cannot live on the DOM node. ProseMirror discards a widget the moment
 * its key changes, and the key carries the diagram's position — so typing a
 * paragraph *above* a diagram rebuilds it, and anything held on the old node
 * goes with it. Deliberately not keyed by paper: changing the theme redraws
 * the picture, but it is still the same picture and the reader is still
 * looking at the same part of it.
 *
 * Keyed by source, which has two consequences worth saying out loud: editing a
 * diagram resets its zoom, which is fair since the picture changed underneath
 * it, and two identical diagrams in one document share an entry. Both are
 * cheaper to accept than to carry an identity through a widget that is rebuilt
 * as often as this one is.
 */
const framed = new Map<string, { k: number; x: number; y: number }>();

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
function fit(stage: HTMLElement, contain = false) {
  const svg = stage.querySelector("svg");
  if (!svg) return;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.removeProperty("max-width");
  svg.style.width = "100%";
  // Contained — the maximised view — the SVG scales to fit *both* axes of the
  // frame, so a tall diagram opens whole rather than centred with its top and
  // bottom cropped somewhere unreachable. In the document the width rules and
  // the figure grows to whatever height that implies.
  svg.style.height = contain ? "100%" : "auto";
  svg.style.maxWidth = "100%";
  svg.style.display = "block";
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

/** Draw into an existing element; failures show the message, not a blank box. */
async function draw(host: HTMLElement, stage: HTMLElement, source: string, contain = false) {
  const at = `${paper()}:${source}`;
  const hit = cache.get(at);
  if (hit) {
    stage.innerHTML = hit;
    host.classList.remove("bad");
    fit(stage, contain);
    return;
  }
  applyTheme();
  try {
    const { svg } = await mermaid.render(`plans-mermaid-${seq++}`, source);
    cache.set(at, svg);
    stage.innerHTML = svg;
    host.classList.remove("bad");
    fit(stage, contain);
  } catch (e) {
    host.classList.add("bad");
    // Into the stage, not the host: writing to the host would take the stage
    // and the reset chip with it, leaving the next redraw nothing to draw in.
    stage.textContent = String(e instanceof Error ? e.message : e).split("\n")[0];
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

/** The paper a diagram was drawn for, so a change of paper redraws it. */
function paper(): string {
  return document.documentElement.dataset.theme ?? "day";
}

/** How far a diagram has been zoomed, and where it has been dragged to. */
type Frame = { k: number; x: number; y: number };

/**
 * Wire zoom, pan and reset onto a frame and the stage inside it.
 *
 * Shared by the figure in the document and by the maximised view, which want
 * exactly the same gestures over a different amount of room — and which would
 * otherwise be eighty lines of pointer arithmetic written twice and corrected
 * once.
 */
function steer(
  frame: HTMLElement,
  stage: HTMLElement,
  seed: Frame,
  save: (at: Frame | null) => void,
  // In the maximised view a plain wheel zooms too: there is no document
  // behind the frame for the scroll to have meant.
  plainWheel = false,
): { home: () => void } {
  let { k, x, y } = seed;

  /**
   * Write the current transform, having first made sure it is one the reader
   * can come back from.
   *
   * The clamp is skipped while the boxes measure zero — which is the case on
   * the very first call, since a widget is built before it is in the document.
   * Without that guard the clamp would collapse to ±0 and write the zeroes
   * back out, destroying the remembered position at the exact moment it was
   * being restored.
   */
  const apply = () => {
    const w = stage.offsetWidth;
    const h = stage.offsetHeight;
    if (w && h) {
      const room = (n: number) => ((k - 1) * n) / 2;
      x = Math.max(-room(w), Math.min(room(w), x));
      y = Math.max(-room(h), Math.min(room(h), y));
    }
    stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    frame.classList.toggle("zoomed", k > 1);
    save(k === 1 && x === 0 && y === 0 ? null : { k, x, y });
  };

  // Paint what was remembered now, so a rebuilt widget never flashes at 1:1,
  // then clamp it once there is a real box to clamp against.
  stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  frame.classList.toggle("zoomed", k > 1);
  requestAnimationFrame(apply);

  /*
   * ⌘/ctrl-wheel, which is also what a trackpad pinch arrives as. A plain
   * wheel is left alone deliberately: the pointer is over a diagram for much
   * of a long plan, and a scroll that zoomed instead would make the document
   * unreadable.
   */
  frame.addEventListener(
    "wheel",
    (e) => {
      if (!plainWheel && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      // A notched mouse wheel reports lines, not pixels; unnormalised, every
      // notch would be an imperceptible fraction of a step.
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // Exponential, so zooming in and back out lands where it started.
      const next = Math.max(1, Math.min(8, k * Math.exp(-d / 240)));
      // Keep whatever is under the pointer under the pointer.
      const r = frame.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      x = cx - ((cx - x) * next) / k;
      y = cy - ((cy - y) * next) / k;
      k = next;
      apply();
    },
    { passive: false },
  );

  /*
   * Drag to pan, but only once there is somewhere to pan to. At 1:1 the whole
   * picture is on screen and a drag means what it means anywhere else.
   *
   * Pointer capture rather than listeners on the document: it keeps a drag
   * alive past the edge of the frame without leaving anything registered
   * outside it.
   */
  let from: { px: number; py: number; x: number; y: number } | null = null;
  frame.addEventListener("pointerdown", (e) => {
    // Never start a pan under a button that is sitting on top of the picture.
    if (k <= 1 || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    frame.setPointerCapture(e.pointerId);
    from = { px: e.clientX, py: e.clientY, x, y };
  });
  frame.addEventListener("pointermove", (e) => {
    if (!from) return;
    x = from.x + (e.clientX - from.px);
    y = from.y + (e.clientY - from.py);
    apply();
  });
  const release = (e: PointerEvent) => {
    if (!from) return;
    from = null;
    if (frame.hasPointerCapture(e.pointerId)) frame.releasePointerCapture(e.pointerId);
  };
  frame.addEventListener("pointerup", release);
  frame.addEventListener("pointercancel", release);

  const home = () => {
    k = 1;
    x = 0;
    y = 0;
    apply();
  };
  frame.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    home();
  });

  return { home };
}

/**
 * The diagram, as big as the window will allow.
 *
 * Zoom inside the figure is looking closer at something in a frame the size of
 * a paragraph, which is the wrong size for the diagrams that most need looking
 * at. This is the same picture with the room to read it.
 *
 * Built into `document.body` rather than into the figure, for two reasons that
 * both matter: the figure clips its overflow, and anything inside the editor's
 * DOM is something ProseMirror believes it owns. Its own copy of the SVG, drawn
 * from the same cache, so nothing is moved out of the document and put back.
 */
function maximise(source: string) {
  const scrim = document.createElement("div");
  scrim.className = "mermaid-scrim";

  const frame = document.createElement("div");
  frame.className = "mermaid-full";
  scrim.append(frame);

  const stage = document.createElement("div");
  stage.className = "mermaid-stage";
  frame.append(stage);

  const tools = document.createElement("div");
  tools.className = "mermaid-tools";
  frame.append(tools);

  const reset = document.createElement("button");
  reset.className = "mermaid-tool";
  reset.type = "button";
  reset.textContent = "1:1";
  reset.title = "Reset the diagram";
  tools.append(reset);

  const close = document.createElement("button");
  close.className = "mermaid-tool";
  close.type = "button";
  close.textContent = "✕";
  close.title = "Close (esc)";
  close.setAttribute("aria-label", "Close");
  tools.append(close);

  // Always opens at a fit, never at whatever the small copy was showing:
  // maximising is a request to see the whole thing.
  const at = steer(frame, stage, { k: 1, x: 0, y: 0 }, () => {}, true);
  reset.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    at.home();
  });

  const shut = () => {
    document.removeEventListener("keydown", onKey, true);
    scrim.remove();
  };
  /*
   * Captured, and stopped.
   *
   * Escape means several things in this app — leave zen, unfocus the editor,
   * close a sheet — and while this is open it means only this. Taking it in
   * the capture phase is what keeps the keystroke from also doing one of the
   * others on its way past.
   */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    shut();
  };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", shut);
  // The backdrop closes; the picture itself does not, or a pan that ends
  // outside the diagram would dismiss it.
  scrim.addEventListener("pointerdown", (e) => {
    if (e.target === scrim) shut();
  });

  void draw(frame, stage, source, true);
  document.body.append(scrim);
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
          // The stage is what moves. Keeping the transform off the figure means
          // the frame stays put and crops, which is what makes a zoom read as
          // looking closer at something rather than the page growing a bulge.
          const stage = document.createElement("div");
          stage.className = "mermaid-stage";
          host.append(stage);

          const tools = document.createElement("div");
          tools.className = "mermaid-tools";
          host.append(tools);

          const big = document.createElement("button");
          big.className = "mermaid-tool";
          big.type = "button";
          big.textContent = "⤢";
          big.title = "Maximise the diagram";
          big.setAttribute("aria-label", "Maximise the diagram");
          tools.append(big);

          const reset = document.createElement("button");
          reset.className = "mermaid-tool";
          reset.type = "button";
          reset.textContent = "1:1";
          reset.title = "Reset the diagram";
          tools.append(reset);

          const at = steer(host, stage, framed.get(source) ?? { k: 1, x: 0, y: 0 }, (now) => {
            if (now) framed.set(source, now);
            else framed.delete(source);
          });
          reset.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            at.home();
          });
          big.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            maximise(source);
          });

          void draw(host, stage, source);
          return host;
        },
        /**
         * Keyed by source *and* paper.
         *
         * ProseMirror reuses a widget whose key has not changed — that is what
         * the key is for, and it is why editing one diagram does not rebuild
         * the rest. But it also meant a theme change rebuilt the decoration set
         * and then reused every widget in it, so the diagrams kept the colours
         * they were drawn with until the file was closed and opened again.
         *
         * The position is in the key too, so an edit anywhere above a diagram
         * rebuilds it. That is why the zoom is remembered in `framed` rather
         * than held on the node: the node does not live long enough.
         */
        {
          side: 1,
          key: `mermaid:${pos}:${paper()}:${source}`,
          // A pan is a drag, and a drag inside the document is a selection
          // unless the widget says otherwise.
          stopEvent: () => true,
          ignoreSelection: true,
        },
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
