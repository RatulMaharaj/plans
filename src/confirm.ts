/**
 * Asking before something irreversible.
 *
 * `window.confirm` is not reliable inside the app: a WKWebView under Tauri
 * suppresses the browser's own dialogs, so the call returns without ever
 * showing anything — and code written as "ask, then delete" quietly becomes
 * "delete". Tauri's dialog plugin puts up a real native sheet instead.
 *
 * The browser path is kept for the test run, which has no Tauri at all. It is
 * the fallback rather than the default precisely because it is the one that
 * cannot be trusted where it matters.
 */
import { ask as tauriAsk } from "@tauri-apps/plugin-dialog";

export async function confirmed(
  message: string,
  {
    title = "Looped Plans",
    kind = "warning" as "warning" | "info" | "error",
    /** The affirmative button. Naming the act beats "Yes" on a destructive one. */
    ok = "Yes",
    cancel = "Cancel",
  } = {},
): Promise<boolean> {
  try {
    return await tauriAsk(message, { title, kind, okLabel: ok, cancelLabel: cancel });
  } catch {
    // No Tauri: the browser's dialog is the honest answer here.
    return window.confirm(message);
  }
}
