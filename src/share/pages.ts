/**
 * The reader's half of the page API.
 *
 * Deliberately small and deliberately separate from `src/workspace.ts`: that
 * module is the app as a signed-in client, and none of it — no token, no
 * keychain, no room — belongs on a public page. All the reader does is ask
 * one address for one document.
 */

export type Page = {
  id: string;
  name: string;
  source: "workspace" | "repository";
  /** A workspace document's page reads the room, so it is worth asking again. */
  live: boolean;
  publishedAt: number;
  markdown: string;
};

/**
 * Where the API is.
 *
 * In a deployment the reader is served by the server itself, so the API is
 * the same origin and the answer is a path. The localStorage override is the
 * same one the app uses, and is for a browser test — or a dev server —
 * pointed at a server it started.
 */
export function apiBase(): string {
  try {
    const local = localStorage.getItem("plans.workspaceServer");
    if (local) return `${local.replace(/\/$/, "")}/api`;
  } catch {
    // no storage: same origin
  }
  return "/api";
}

/**
 * Which plan this is.
 *
 * The address is the whole of it: `plans.looped.sh/{id}`. `?id=` is the same
 * thing said explicitly, for a dev server that does not do the server's
 * routing — the e2e test runs the reader off Vite, not off the server.
 */
export function pageId(): string | null {
  const asked = new URLSearchParams(location.search).get("id");
  if (asked) return asked;
  const seg = location.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(seg) ? seg : null;
}

/**
 * The plan, or null when there isn't one.
 *
 * Null covers revoked, never-shared and misspelt alike — the page says the
 * same thing to all three, because distinguishing them would tell a stranger
 * which ids exist. A thrown error is something else: the server is not
 * answering, which is worth saying differently.
 */
export async function fetchPage(id: string): Promise<Page | null> {
  const res = await fetch(`${apiBase()}/pages/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return (await res.json()) as Page;
}
