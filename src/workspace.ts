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
 * Not a setting: the server is operated with the app, and a URL field in
 * settings would be a second thing to get wrong for the one person who runs
 * their own. The address is baked in at build time from `VITE_WORKSPACE_URL`;
 * a build made without one has no workspaces at all, and hides them. The
 * localStorage override is for a browser test pointed at a server it started.
 */
const BUILT = ((import.meta.env.VITE_WORKSPACE_URL as string | undefined) ?? "").trim();

export function serverUrl(): string {
  try {
    const local = localStorage.getItem("plans.workspaceServer");
    if (local) return local.replace(/\/$/, "");
  } catch {
    // no storage: the built address
  }
  return BUILT.replace(/\/$/, "");
}

/** Whether this build knows a server to talk to. Without one, no workspaces. */
export function configured(): boolean {
  return serverUrl().length > 0;
}

export type Account = { login: string; name: string | null; avatar: string | null };

export type Workspace = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  members: string[];
};

/**
 * One line of a workspace's tree: a path, what is at it, and — for a file —
 * the id of the document that holds it. A rename is a move of the path; `doc`
 * does not change, so everyone editing the file carries on editing it.
 *
 * `status` is the file's `status:` frontmatter, written into the tree by
 * whoever has the file open. It is a copy, and the file is the truth; it is
 * here so a tree of fifty files can be drawn with its status dots without
 * opening fifty rooms to read them.
 */
export type WorkspaceEntry = {
  path: string;
  kind: "file" | "folder";
  doc: string | null;
  status?: string | null;
};

/**
 * A published plan, as the server answers when one is made or asked after.
 * `markdown` is what the server holds — empty for a workspace document, whose
 * page reads the live room instead of a copy.
 */
export type Page = {
  id: string;
  source: "workspace" | "repository";
  workspaceId: string | null;
  repo: string | null;
  path: string | null;
  name: string;
  markdown: string;
  publishedBy: string;
  publishedAt: number;
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

/**
 * Everything the app asks the server for is under `/api`.
 *
 * The root belongs to the reader now — `/` and `/{id}` serve public pages —
 * so the API moved out of its way. See plans/public-plan-pages.md.
 */
async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== false) {
    const t = await token();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(`${serverUrl()}/api${path}`, {
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
  /** Walk out of a workspace someone else made. */
  leave: (id: string) => call<{ ok: true }>(`/workspaces/${id}/members/me`, { method: "DELETE" }),
  /** Delete a workspace you made: its files, its members, its pages. */
  remove: (id: string) => call<{ ok: true }>(`/workspaces/${id}`, { method: "DELETE" }),
  /**
   * The tree, for a cold open: what the sidebar draws before a socket into
   * the room is up. Once one is, the tree room's own map is the truth and
   * this is not asked again.
   */
  tree: (id: string) => call<WorkspaceEntry[]>(`/workspaces/${id}/tree`),
  /** Mint the read token an outside agent uses for `GET /w/{id}/{path}`. */
  readToken: (id: string) => call<{ token: string }>(`/workspaces/${id}/token`, { method: "POST" }),
  readUrl: (id: string, path = "plan.md") => `${serverUrl()}/api/w/${id}/${path}`,

  /**
   * Publishing: a plan at an address anyone can open.
   *
   * A repository file publishes a copy, republished on every save while
   * sharing is on. A workspace document publishes nothing — its page reads
   * the room — and publishing it twice hands back the page it already has,
   * so the URL a member shared stays the URL.
   */
  pages: {
    publishFile: (repo: string, path: string, name: string, markdown: string) =>
      call<Page>("/pages", { body: { repo, path, name, markdown } }),
    publishWorkspace: (workspaceId: string, path: string) =>
      call<Page>("/pages", { body: { workspaceId, path } }),
    republish: (id: string, name: string, markdown: string) =>
      call<Page>("/pages", { body: { id, name, markdown } }),
    stop: (id: string) => call<{ ok: true }>(`/pages/${id}`, { method: "DELETE" }),
    /** Whether this workspace file is published, for a member. */
    forWorkspace: (id: string, path: string) =>
      call<Page | null>(`/workspaces/${id}/page?path=${encodeURIComponent(path)}`),
  },
  /** Where a published plan lives. The id is the whole of the secret. */
  pageUrl: (id: string) => `${serverUrl()}/${id}`,

};

// --- the live document ---------------------------------------------------------

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export type Presence = { name: string; color: string; avatar?: string | null };

/** Someone in a room, and — on a workspace's tree room — which file they are in. */
export type Present = Presence & { at: string | null };

/**
 * Everyone else in a room. Presence rides Yjs awareness: each client sets a
 * `user` (name, colour, face) and, on the tree room, `at` (the file it has
 * open), and the server relays the lot. Our own state is left out — a face
 * beside a file is news about other people.
 */
export function presentIn(room: Room): Present[] {
  const out: Present[] = [];
  for (const [client, state] of room.awareness.getStates()) {
    if (client === room.doc.clientID) continue;
    const user = state?.user as Presence | undefined;
    if (!user?.name) continue;
    out.push({ ...user, at: typeof state?.at === "string" ? state.at : null });
  }
  return out;
}

/** One open room: one document, and who else is in it. */
export type Room = {
  /** The document's id — a workspace's own id, for its tree. */
  id: string;
  /** The workspace the document belongs to, which is what authorises it. */
  workspaceId: string;
  doc: Y.Doc;
  awareness: Awareness;
  /** True once the server's state has arrived — until then the doc is empty
   *  for a reason that is not "the document is empty". */
  synced: boolean;
  onSynced: (fn: () => void) => () => void;
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
 * Open one document of a workspace over a websocket that speaks
 * y-websocket's protocol, reconnecting on its own when the line drops. Yjs
 * merges whatever happened while it was away.
 *
 * `id` is the document — the workspace's own id opens its tree — and
 * `workspaceId` is what the server checks membership against. They are both
 * sent because a file made a moment ago is named by the tree before anything
 * has been written to it, so the server has nothing else to look it up by.
 */
export function openRoom(id: string, workspaceId: string, session: string, me: Presence): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", me);

  const syncedFns = new Set<() => void>();
  const statusFns = new Set<(s: Room["status"]) => void>();
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | null = null;

  const room: Room = {
    id,
    workspaceId,
    doc,
    awareness,
    synced: false,
    status: "connecting",
    onSynced: (fn) => (syncedFns.add(fn), () => syncedFns.delete(fn)),
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
    const url = `${serverUrl().replace(/^http/, "ws")}/api/ws/${id}?token=${encodeURIComponent(
      session,
    )}&workspace=${encodeURIComponent(workspaceId)}`;
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
      }
    };

    sock.onclose = (ev: CloseEvent) => {
      if (ws === sock) ws = null;
      // 4001 is the server saying the workspace is gone: nothing to come back to.
      if (ev.code === 4001) closed = true;
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

// --- the tree -------------------------------------------------------------

/**
 * The shape a tree room's map holds at each path.
 *
 * Plain objects rather than nested Yjs types: an entry is replaced whole and
 * never edited in place, so there is nothing here for two people to merge
 * *within* — the merge that matters is over the map's keys, which is where
 * two people making files at once actually meet.
 */
export type TreeValue = { kind: "file" | "folder"; doc?: string | null; status?: string | null };

/** A workspace's tree lives in the room whose id is the workspace's own. */
export const treeRoomId = (workspaceId: string) => workspaceId;

export function treeMap(room: Room) {
  return room.doc.getMap<TreeValue>("tree");
}

/** The tree as a sorted list, which is what the file tree draws. */
export function treeEntries(room: Room): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = [];
  for (const [path, v] of treeMap(room)) {
    if (!v || typeof v !== "object") continue;
    out.push({
      path,
      kind: v.kind === "folder" ? "folder" : "file",
      doc: v.doc ?? null,
      status: v.status ?? null,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * An id for a new file's document.
 *
 * Made by whoever creates the file rather than asked for: creating a file is a
 * transaction on the tree, and a round trip in the middle of it would be a
 * file that exists for one person before it exists for anyone else. It is
 * random enough that two people making a file at the same instant do not
 * collide.
 */
export function newDocId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create, rename, move and delete, as transactions on the tree.
 *
 * Each one lands for everyone at once, and two people acting together merge
 * rather than fight. A rename is a move of the key: the document id travels
 * with it, so anyone with the file open carries on editing the same document
 * under its new name.
 */
/**
 * A destination that is already taken. Every operation below refuses one
 * rather than writing over it: a map `set` on an existing key is a silent
 * delete of whatever was there, and a tree is the one place that must never
 * lose a file by accident. The message reads as the toast it becomes.
 */
export class TreeError extends Error {}

export const tree = {
  /** The new file's document id, so the caller can open its room. */
  addFile(room: Room, path: string): string {
    const map = treeMap(room);
    if (map.has(path)) throw new TreeError(`${path} is already here`);
    const doc = newDocId();
    map.set(path, { kind: "file", doc });
    return doc;
  },
  addFolder(room: Room, path: string) {
    const map = treeMap(room);
    if (map.has(path)) throw new TreeError(`${path} is already here`);
    map.set(path, { kind: "folder" });
  },
  /**
   * Everything at or under `from`, moved to `to`. Folders bring their files.
   * Refused when anything would land on an entry that exists, or when a
   * folder would be moved into itself.
   */
  move(room: Room, from: string, to: string) {
    if (from === to) return;
    if (to.startsWith(`${from}/`)) throw new TreeError(`${from} cannot be moved inside itself`);
    const map = treeMap(room);
    const moving = [...map].filter(([path]) => path === from || path.startsWith(`${from}/`));
    for (const [path] of moving) {
      const dest = `${to}${path.slice(from.length)}`;
      if (map.has(dest)) throw new TreeError(`${dest} is already here`);
    }
    room.doc.transact(() => {
      for (const [path, value] of moving) {
        map.delete(path);
        map.set(`${to}${path.slice(from.length)}`, value);
      }
    });
  },
  /** A file, or a folder and everything inside it. */
  remove(room: Room, path: string) {
    const map = treeMap(room);
    room.doc.transact(() => {
      for (const key of [...map.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) map.delete(key);
      }
    });
  },
  /**
   * Copy a file's `status:` into the tree, so the sidebar can draw its dot.
   * Only when it changed: a set of the same value is still an update, and
   * every client with the file open runs this.
   */
  setStatus(room: Room, path: string, status: string | null) {
    const map = treeMap(room);
    const at = map.get(path);
    if (!at || at.kind !== "file") return;
    if ((at.status ?? null) === status) return;
    map.set(path, { ...at, status });
  },
};

// --- the scratch folder ---------------------------------------------------

/**
 * One line of the tree as the scratch folder is written from it. A file's
 * `text` is the room's `meta.markdown`, or "" for a file no editor has
 * published yet.
 */
export type ScratchFile = { path: string; kind: "file" | "folder"; text?: string };

/** A scratch folder being kept current, and the two things you can do to it. */
export type ScratchHandle = {
  /** Write what the rooms hold now, and wait for it to land. */
  flush: () => Promise<void>;
  /** Stop following the rooms. The rooms themselves are left to their owner. */
  stop: () => void;
};

/**
 * Keep a workspace's scratch folder current with its rooms.
 *
 * An agent starts in a folder that is a copy of the workspace, and a copy is
 * only worth anything while it is fresh. This follows the tree room for
 * files coming and going and every file's room for its text, and hands the
 * whole tree to `put` on a short debounce after anything moves — the same
 * beat on which an editor publishes `meta.markdown`, so the agent's next
 * read sees what was typed a moment ago. The whole tree every time, because
 * the folder is small and a full write is the one that cannot drift.
 *
 * Rooms are opened through `open` and belong to whoever answers it; a file
 * nobody has on screen still has a room here, since the folder has to hold
 * its text too. Puts are serialised so a later tree never lands before an
 * earlier one.
 */
export function scratch(
  tree: Room,
  open: (docId: string) => Promise<Room | null>,
  put: (files: ScratchFile[]) => Promise<unknown>,
): ScratchHandle {
  /** `room` is null while `open` is still answering. */
  const watched = new Map<string, { room: Room | null; off: () => void }>();
  let stopped = false;
  let timer: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const files = (): ScratchFile[] =>
    treeEntries(tree).map((e) =>
      e.kind === "folder"
        ? { path: e.path, kind: "folder" as const }
        : {
            path: e.path,
            kind: "file" as const,
            text: (e.doc && watched.get(e.doc)?.room?.doc.getMap<string>("meta").get("markdown")) || "",
          },
    );

  const write = () => {
    if (stopped) return chain;
    const snapshot = files();
    chain = chain.then(() => put(snapshot)).catch(() => {});
    return chain;
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void write();
    }, 200);
  };

  /** Every file in the tree has a room being watched; nothing else does. */
  const follow = () => {
    if (stopped) return;
    const wanted = new Set<string>();
    for (const e of treeEntries(tree)) {
      if (e.kind !== "file" || !e.doc) continue;
      wanted.add(e.doc);
      if (watched.has(e.doc)) continue;
      // Reserved before the room arrives, so two changes in a row do not
      // open it twice.
      const doc = e.doc;
      const slot = { room: null as Room | null, off: () => {} };
      watched.set(doc, slot);
      void open(doc).then((room) => {
        if (stopped || !room) {
          if (watched.get(doc) === slot) watched.delete(doc);
          return;
        }
        const meta = room.doc.getMap<string>("meta");
        const changed = () => schedule();
        meta.observe(changed);
        const unsync = room.onSynced(changed);
        slot.room = room;
        slot.off = () => {
          meta.unobserve(changed);
          unsync();
        };
        schedule();
      });
    }
    for (const [doc, w] of [...watched]) {
      if (wanted.has(doc)) continue;
      w.off();
      watched.delete(doc);
    }
  };

  const onTree = () => {
    follow();
    schedule();
  };
  treeMap(tree).observe(onTree);
  const unsyncTree = tree.onSynced(onTree);
  onTree();

  return {
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await write();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      treeMap(tree).unobserve(onTree);
      unsyncTree();
      for (const w of watched.values()) w.off();
      watched.clear();
    },
  };
}
