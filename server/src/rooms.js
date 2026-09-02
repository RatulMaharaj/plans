/**
 * One Yjs document per room, relayed over websockets.
 *
 * A room is a document, not a workspace: a workspace is a *tree* room holding
 * a map of path → `{ kind, doc }`, plus one room per file keyed by that file's
 * document id. Which workspace a room belongs to is what the socket's
 * membership check is made of, and it comes from the `docs` table.
 *
 * This is the y-websocket wire protocol — sync steps and awareness — written
 * out rather than pulled in, because the whole server is a few hundred lines
 * and the dependency would be most of them.
 */
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { newId } from "./db.js";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/** How long a burst of edits waits before it is written to the database. */
const SAVE_AFTER_MS = 800;

/**
 * The name a workspace's first file has.
 *
 * A workspace used to be one document, and the read endpoint and every share
 * link minted before folders named `plan.md`. Seeding a new tree with the same
 * name is what keeps all of that answering.
 */
export const FIRST_FILE = "plan.md";

/** The tree of a workspace lives in the room whose id *is* the workspace's. */
export const treeId = (workspaceId) => workspaceId;

/** The tree map, as the wire and the app both see it. */
function entriesOf(doc) {
  const out = [];
  for (const [path, value] of doc.getMap("tree")) {
    if (!value || typeof value !== "object") continue;
    out.push({ path, kind: value.kind === "folder" ? "folder" : "file", doc: value.doc ?? null, status: value.status ?? null });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export class Rooms {
  constructor() {
    /** Set by the server once the database is up; no room opens before. */
    this.db = null;
    /** doc id -> { id, workspaceId, kind, doc, awareness, conns, saveTimer } */
    this.rooms = new Map();
  }

  /** The live document, loading it from the database on first sight. */
  async room(id, workspaceId, kind) {
    let room = this.rooms.get(id);
    if (room) return room;
    const doc = new Y.Doc();
    const stored = await this.db.loadDoc(id);
    if (stored) Y.applyUpdate(doc, stored);
    // A tree nobody has written yet is a workspace from before folders, or one
    // whose creation was interrupted: either way it gets its first file here,
    // before anyone can see the room as empty.
    if (kind === "tree") await this.seedInto(doc, workspaceId);
    // Two joins raced the load: the first to finish is the room.
    if (this.rooms.has(id)) {
      doc.destroy();
      return this.rooms.get(id);
    }
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    room = { id, workspaceId, kind, doc, awareness, conns: new Set(), saveTimer: null };

    doc.on("update", (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of room.conns) if (c !== origin) send(c, msg);
      if (room.saveTimer) clearTimeout(room.saveTimer);
      room.saveTimer = setTimeout(() => {
        room.saveTimer = null;
        void this.save(room).catch(logSave);
      }, SAVE_AFTER_MS);
    });

    awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of room.conns) if (c !== origin) send(c, msg);
    });

    this.rooms.set(id, room);
    return room;
  }

  save(room) {
    return this.db.saveDoc(room.id, room.workspaceId, room.kind, Y.encodeStateAsUpdate(room.doc));
  }

  /**
   * Give an empty tree its first file.
   *
   * A workspace that already has a document — one written before workspaces
   * were folders — keeps it, under the name the read endpoint and every share
   * link minted back then were already using. A new one gets an empty document
   * saved under a fresh id, so the tree never names a room that does not exist.
   */
  async seedInto(doc, workspaceId) {
    const map = doc.getMap("tree");
    if (map.size > 0) return false;
    const existing = await this.db.docsFor(workspaceId, "file");
    if (map.size > 0) return false;
    const id = existing[0]?.id ?? newId();
    if (!existing.length) {
      await this.db.saveDoc(id, workspaceId, "file", Y.encodeStateAsUpdate(new Y.Doc()));
    }
    map.set(FIRST_FILE, { kind: "file", doc: id });
    return true;
  }

  /** A workspace's tree, seeded if it has never had one. Read-only callers. */
  async tree(workspaceId) {
    const live = this.rooms.get(treeId(workspaceId));
    if (live) return entriesOf(live.doc);
    const doc = new Y.Doc();
    const stored = await this.db.loadDoc(treeId(workspaceId));
    if (stored) Y.applyUpdate(doc, stored);
    if (await this.seedInto(doc, workspaceId)) {
      await this.db.saveDoc(treeId(workspaceId), workspaceId, "tree", Y.encodeStateAsUpdate(doc));
    }
    const out = entriesOf(doc);
    doc.destroy();
    return out;
  }

  /** Make the tree for a workspace that has just been created. */
  seed(workspaceId) {
    return this.tree(workspaceId);
  }

  /** The markdown the clients last serialised, for one document. */
  async markdown(id) {
    const room = this.rooms.get(id);
    if (room) return room.doc.getMap("meta").get("markdown") ?? "";
    const stored = await this.db.loadDoc(id);
    if (!stored) return "";
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored);
    const text = doc.getMap("meta").get("markdown") ?? "";
    doc.destroy();
    return text;
  }

  /** One file of one workspace, by path; null when the tree has no such file. */
  async markdownAt(workspaceId, path) {
    const entry = (await this.tree(workspaceId)).find((e) => e.path === path && e.kind === "file");
    if (!entry?.doc) return null;
    return this.markdown(entry.doc);
  }

  async join(id, workspaceId, kind, ws) {
    ws.binaryType = "arraybuffer";
    /** Which awareness clients this socket spoke for, to clear on close. */
    const controlled = new Set();
    /**
     * Listen before the room exists. The client sends its first sync step the
     * moment the socket opens, and loading the document from the database
     * takes a real round trip — anything that arrived in between was lost,
     * and a lost step one is a client that never syncs.
     */
    let room = null;
    let gone = false;
    const early = [];
    ws.on("message", (data) => (room ? this.handle(room, ws, controlled, data) : early.push(data)));
    ws.on("close", () => {
      gone = true;
      if (room) void this.leave(room, ws, controlled);
    });

    room = await this.room(id, workspaceId, kind);
    if (gone) return;
    room.conns.add(ws);
    for (const data of early) this.handle(room, ws, controlled, data);
    if (ws.readyState !== 1) return;

    // Open with our state vector, then everyone's presence.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        a,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
      );
      send(ws, encoding.toUint8Array(a));
    }
  }

  /**
   * One frame from one client. A frame the protocol cannot read — empty,
   * truncated, or not ours — closes that client and nothing else: a member's
   * bad byte must never take the room, let alone the process, down with it.
   */
  handle(room, ws, controlled, data) {
    try {
      this.decode(room, ws, controlled, data);
    } catch (e) {
      console.warn(`closing a client of ${room.id}: ${e.message}`);
      ws.close(1003, "bad frame");
    }
  }

  decode(room, ws, controlled, data) {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec);
      // Remember whose states arrived through this socket.
      const peek = decoding.createDecoder(update);
      const n = decoding.readVarUint(peek);
      for (let i = 0; i < n; i++) {
        controlled.add(decoding.readVarUint(peek));
        decoding.readVarUint(peek);
        decoding.readVarString(peek);
      }
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
    }
  }

  async leave(room, ws, controlled) {
    room.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
    if (room.conns.size !== 0) return;
    // The last reader left: write it out, and only then let the memory go.
    // The room stays in the map while the write is in flight, so someone
    // reconnecting in that window joins this document rather than loading
    // the database's older copy and being overwritten by this save later.
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = null;
    await this.save(room).catch(logSave);
    if (room.conns.size !== 0 || this.rooms.get(room.id) !== room) return;
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(room.id);
  }

  /** Write everything out; called on shutdown. */
  async flush() {
    for (const room of this.rooms.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      await this.save(room).catch(logSave);
    }
  }
}

function logSave(e) {
  console.error("could not save a document", e);
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(msg);
  } catch {
    ws.close();
  }
}
