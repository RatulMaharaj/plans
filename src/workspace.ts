/**
 * The app as a client of the workspace server.
 *
 * Everything the server knows is behind two things: an HTTP API for who you
 * are and which rooms you are in, and one websocket per open document for
 * the document itself. This module is both, and nothing in it touches disk —
 * a workspace is the third kind of buffer, the one whose truth is on the wire.
 * See plans/hosted-workspaces.md and server/README.md.
 */
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { api } from "./api";

/**
 * Where the server is.
 *
 * A fixed address, not a setting: the server is operated with the app, and a
 * URL field in settings would be a second thing to get wrong for the one
 * person who runs their own. The two overrides are for development — a build
 * pointed at a local server, or a browser test pointed at one it started.
 */
const DEFAULT_SERVER = "https://workspaces.plans.ratulmaharaj.com";

export function serverUrl(): string {
  try {
    const local = localStorage.getItem("plans.workspaceServer");
    if (local) return local.replace(/\/$/, "");
  } catch {
    // no storage: the default
  }
  const built = import.meta.env.VITE_WORKSPACE_URL as string | undefined;
  return (built || DEFAULT_SERVER).replace(/\/$/, "");
}

export type Account = { login: string; name: string | null; avatar: string | null };

export type Review = {
  state: "none" | "requested" | "approved" | "changes";
  requestedBy: string | null;
  decidedBy: string | null;
  at: number | null;
};

export type Workspace = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  members: string[];
  review: Review;
};

export type DeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
};

// --- the session --------------------------------------------------------------

/** The session token, held in the OS keychain by the Rust side. */
let cached: string | null | undefined;

export async function token(): Promise<string | null> {
  if (cached === undefined) cached = await api.workspaceTokenGet().catch(() => null);
  return cached;
}

async function setToken(t: string | null) {
  cached = t;
  if (t) await api.workspaceTokenSet(t);
  else await api.workspaceTokenClear();
}

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== false) {
    const t = await token();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(`${serverUrl()}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      // plain text error
    }
    throw new WorkspaceError(res.status, message || `${res.status}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const workspace = {
  /** Who is signed in, or null — including when the token has gone stale. */
  async me(): Promise<Account | null> {
    if (!(await token())) return null;
    try {
      return await call<Account>("/me");
    } catch (e) {
      if (e instanceof WorkspaceError && e.status === 401) {
        await setToken(null);
        return null;
      }
      throw e;
    }
  },

  /** Step one of signing in: a code to type at GitHub. */
  startSignIn: () => call<DeviceStart>("/auth/device", { method: "POST", auth: false }),

  /**
   * Step two, repeated at GitHub's interval: done yet? The account once they
   * have typed the code (and the session is kept); otherwise whether GitHub
   * asked for a slower cadence, which the caller must honour.
   */
  async pollSignIn(deviceCode: string): Promise<{ account: Account | null; slowDown: boolean }> {
    const r = await call<{ pending?: boolean; slowDown?: boolean; token?: string; user?: Account }>(
      "/auth/device/poll",
      { body: { deviceCode }, auth: false },
    );
    if (r.pending || !r.token || !r.user) return { account: null, slowDown: !!r.slowDown };
    await setToken(r.token);
    return { account: r.user, slowDown: false };
  },

  async signOut() {
    try {
      await call("/auth/signout", { method: "POST" });
    } catch {
      // The session is gone from here regardless.
    }
    await setToken(null);
  },

  list: () => call<Workspace[]>("/workspaces"),
  get: (id: string) => call<Workspace>(`/workspaces/${id}`),
  create: (name: string) => call<Workspace>("/workspaces", { body: { name } }),
  invite: (id: string, login: string) => call<Workspace>(`/workspaces/${id}/members`, { body: { login } }),
  review: (id: string, action: "request" | "approve" | "changes" | "clear") =>
    call<Review>(`/workspaces/${id}/review`, { body: { action } }),
  /** Mint the read token an outside agent uses for `GET /w/{id}/plan.md`. */
  readToken: (id: string) => call<{ token: string }>(`/workspaces/${id}/token`, { method: "POST" }),
  readUrl: (id: string) => `${serverUrl()}/w/${id}/plan.md`,
};

// --- the live document ---------------------------------------------------------

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_REVIEW = 2;

export type Presence = { name: string; color: string };

/** One open room: the doc, who is in it, and the server's word on review. */
export type Room = {
  id: string;
  doc: Y.Doc;
  awareness: Awareness;
  /** True once the server's state has arrived — until then the doc is empty
   *  for a reason that is not "the document is empty". */
  synced: boolean;
  onSynced: (fn: () => void) => () => void;
  onReview: (fn: (r: Review) => void) => () => void;
  onStatus: (fn: (s: "connecting" | "open" | "closed") => void) => () => void;
  status: "connecting" | "open" | "closed";
  close: () => void;
};

/**
 * The colour a person's cursor wears, from their login: stable across
 * sessions and machines without anyone having to agree on it.
 */
export function colorFor(login: string): string {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (Math.imul(31, h) + login.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 55% 48%)`;
}

/**
 * Open a workspace's document over a websocket that speaks y-websocket's
 * protocol, reconnecting on its own when the line drops. Yjs merges whatever
 * happened while it was away.
 */
export function openRoom(id: string, session: string, me: Presence): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", me);

  const syncedFns = new Set<() => void>();
  const reviewFns = new Set<(r: Review) => void>();
  const statusFns = new Set<(s: Room["status"]) => void>();
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | null = null;

  const room: Room = {
    id,
    doc,
    awareness,
    synced: false,
    status: "connecting",
    onSynced: (fn) => (syncedFns.add(fn), () => syncedFns.delete(fn)),
    onReview: (fn) => (reviewFns.add(fn), () => reviewFns.delete(fn)),
    onStatus: (fn) => (statusFns.add(fn), () => statusFns.delete(fn)),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      removeAwarenessStates(awareness, [doc.clientID], "close");
      ws?.close();
      awareness.destroy();
      doc.destroy();
    },
  };

  const setStatus = (s: Room["status"]) => {
    room.status = s;
    for (const fn of statusFns) fn(s);
  };

  const send = (bytes: Uint8Array) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(bytes);
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    send(encoding.toUint8Array(enc));
  });

  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "remote") return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(awareness, changed));
    send(encoding.toUint8Array(enc));
  });

  const connect = () => {
    if (closed) return;
    const url = `${serverUrl().replace(/^http/, "ws")}/ws/${id}?token=${encodeURIComponent(session)}`;
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    ws = sock;
    setStatus("connecting");

    sock.onopen = () => {
      retry = 0;
      setStatus("open");
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      sock.send(encoding.toUint8Array(enc));
      // Announce ourselves again after a reconnect; the server forgot.
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, encodeAwarenessUpdate(awareness, [doc.clientID]));
      sock.send(encoding.toUint8Array(a));
    };

    sock.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(dec, enc, doc, "remote");
        if (encoding.length(enc) > 1) sock.send(encoding.toUint8Array(enc));
        if (kind === syncProtocol.messageYjsSyncStep2 && !room.synced) {
          room.synced = true;
          for (const fn of syncedFns) fn();
        }
      } else if (type === MSG_AWARENESS) {
        applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), "remote");
      } else if (type === MSG_REVIEW) {
        const r = JSON.parse(decoding.readVarString(dec)) as Review;
        for (const fn of reviewFns) fn(r);
      }
    };

    sock.onclose = () => {
      if (ws === sock) ws = null;
      setStatus("closed");
      if (closed) return;
      // Others' cursors are stale the moment the line drops.
      const gone = [...awareness.getStates().keys()].filter((c) => c !== doc.clientID);
      removeAwarenessStates(awareness, gone, "remote");
      timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
    };
    sock.onerror = () => sock.close();
  };

  connect();
  return room;
}
