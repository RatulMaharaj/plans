/**
 * Paste or drop an image and it lands in the repository.
 *
 * Without this there is nowhere for a screenshot to go: Crepe would inline it
 * as a data URL, which bloats the file and is unreadable in every other tool,
 * or drop it entirely. The bytes are written next to the document, in an
 * `assets/` folder, and what goes into the markdown is an ordinary relative
 * link — the same thing a person would have typed.
 *
 * Caught in the capture phase for the same reason as the link paste: Crepe's
 * own handling runs first otherwise.
 */
import { $prose } from "@milkdown/utils";
import { imageSchema } from "@milkdown/preset-commonmark";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { api } from "./api";

/** Which file we are in, so the image can be written beside it. */
export const imageContext = { repo: "", relPath: "" };

const KIND = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i;

function extensionFor(type: string): string {
  const sub = type.split("/")[1] ?? "png";
  if (sub === "svg+xml") return "svg";
  if (sub === "jpeg") return "jpg";
  return sub;
}

/** The document's own name, so the folder reads as belonging to it. */
function stemFor(relPath: string): string {
  const name = relPath.split("/").pop() ?? "image";
  return name.replace(/\.(md|markdown)$/i, "") || "image";
}

async function insert(view: { state: any; dispatch: (tr: any) => void }, ctx: any, file: File) {
  const { repo, relPath } = imageContext;
  if (!repo || !relPath) return;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await api.writeAsset(
    repo,
    relPath,
    stemFor(relPath),
    extensionFor(file.type),
    Array.from(bytes),
  );

  const image = imageSchema.type(ctx);
  const node = image.create({ src, alt: "" });
  const { state, dispatch } = view;
  dispatch(state.tr.replaceSelectionWith(node, false).scrollIntoView());
}

export const pasteImage = $prose((ctx) => {
  return new Plugin({
    key: new PluginKey("plans-paste-image"),
    view: (view) => {
      const filesFrom = (data: DataTransfer | null) =>
        [...(data?.files ?? [])].filter((f) => KIND.test(f.type));

      const onPaste = (event: ClipboardEvent) => {
        const files = filesFrom(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void insert(view, ctx, files[0]);
      };

      const onDrop = (event: DragEvent) => {
        const files = filesFrom(event.dataTransfer);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void insert(view, ctx, files[0]);
      };

      view.dom.addEventListener("paste", onPaste, true);
      view.dom.addEventListener("drop", onDrop, true);
      return {
        destroy: () => {
          view.dom.removeEventListener("paste", onPaste, true);
          view.dom.removeEventListener("drop", onDrop, true);
        },
      };
    },
  });
});
