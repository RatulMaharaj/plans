/**
 * A published plan, in a browser with no account.
 *
 * The renderer is the app's: the same Editor, the same markdown pipeline, the
 * same mermaid and the same theme, with the caret taken away. That is the
 * whole design — a second renderer would always lag the one people write in,
 * and this page and the editor can never disagree about a table.
 *
 * See plans/public-plan-pages.md.
 */
import { useEffect, useState } from "react";
import { Editor } from "../Editor";
import { splitFrontmatter, matterValue, statusTone } from "../matter";
import { fetchPage, pageId, type Page as Plan } from "./pages";
import "./page.css";

/** How often the page asks whether the plan has moved on. */
const POLL_MS = 5_000;

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "unreachable"; why: string }
  /** `version` counts accepted changes: it is what re-swaps the document. */
  | { kind: "plan"; plan: Plan; version: number };

export function Page() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const id = pageId();

  /**
   * Ask, and keep asking.
   *
   * A page follows its source: a workspace document as the room changes it, a
   * repository file as its author saves. Polling rather than a socket —
   * cheap, no session, and a reader is not a collaborator. Once the plan is
   * gone the asking stops: sharing was stopped, and that is a final answer.
   */
  useEffect(() => {
    if (!id) {
      setState({ kind: "missing" });
      return;
    }
    let alive = true;
    let timer: number | null = null;
    const ask = async () => {
      try {
        const plan = await fetchPage(id);
        if (!alive) return;
        if (!plan) {
          setState({ kind: "missing" });
          return;
        }
        // Replace only when something changed, so an unchanged poll does not
        // rebuild the document under someone who is reading it.
        setState((prev) =>
          prev.kind === "plan" && prev.plan.markdown === plan.markdown && prev.plan.name === plan.name
            ? prev
            : { kind: "plan", plan, version: (prev.kind === "plan" ? prev.version : 0) + 1 },
        );
        timer = window.setTimeout(() => void ask(), POLL_MS);
      } catch (e) {
        if (!alive) return;
        // The server, not the plan: say so, and try again rather than
        // claiming the plan is not shared.
        setState((prev) =>
          prev.kind === "plan" ? prev : { kind: "unreachable", why: e instanceof Error ? e.message : String(e) },
        );
        timer = window.setTimeout(() => void ask(), POLL_MS);
      }
    };
    void ask();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    document.title = state.kind === "plan" ? state.plan.name : "Plan";
  }, [state]);

  if (state.kind === "loading") return <div className="share-wait">Opening…</div>;
  if (state.kind === "unreachable") {
    return (
      <div className="share-gone">
        <h1>Not right now</h1>
        <p>{state.why}. This page will keep trying.</p>
      </div>
    );
  }
  if (state.kind === "missing") {
    // Never an error: the commonest reason to be here is that someone stopped
    // sharing, which is not a fault of the person reading.
    return (
      <div className="share-gone">
        <h1>This plan is not shared</h1>
        <p>
          Whoever shared it has stopped, or the link was mistyped. Ask them for a new link — a shared
          plan lives at an address of its own, and that address is the whole of it.
        </p>
      </div>
    );
  }

  const { plan, version } = state;
  const { matter, body } = splitFrontmatter(plan.markdown);
  const status = matter ? matterValue(matter, "status") : null;
  const owner = matter ? (matterValue(matter, "owner") ?? matterValue(matter, "assignee")) : null;

  return (
    <div className="share-page">
      <div className="page-head">
        <span className="page-path">{plan.name}</span>
        <span className="page-actions">
          {status && (
            <span className={`status-badge tone-${statusTone(status)}`} title="status: from this plan's frontmatter">
              {status}
            </span>
          )}
          {owner && <span className="matter-owner">@{owner}</span>}
          {/* How fresh this is. A live page is whatever the room says right
              now, so only a file's page has a "then" to report. */}
          {!plan.live && <span className="share-when">published {ago(plan.publishedAt)}</span>}
        </span>
      </div>
      <Editor
        docKey={`${plan.id}:${version}`}
        // No repository to resolve relative images against, and none to
        // invent: an image the plan points at on someone's disk says so
        // rather than showing a broken frame.
        repo=""
        relPath={plan.name}
        initialValue={body}
        spellcheck={false}
        imageFolder=""
        author=""
        readOnly
        onChange={() => {}}
        onOpenLink={openLink}
      />
    </div>
  );
}

/**
 * A link on a public page.
 *
 * Anything with a scheme opens in a new tab. A relative link is a plan
 * pointing at a plan beside it on someone's disk — there is nothing here to
 * open, and following it would land the reader on a 404 dressed as a plan, so
 * it does nothing at all.
 */
function openLink(href: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
}

/** "today", "3 days ago" — the same voice the app's share sheet uses. */
export function ago(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
