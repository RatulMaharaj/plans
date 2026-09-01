/**
 * One Yjs document per workspace, relayed over websockets.
 *
 * This is the y-websocket wire protocol — sync steps and awareness — written
 * out rather than pulled in, because the whole server is a few hundred lines
 * and the dependency would be most of them. A third message type carries
 * review state, which is the server's to announce and nobody's to edit.
 */
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_REVIEW = 2;

/** How long a burst of edits waits before it is written to the database. */
const SAVE_AFTER_MS = 800;

export class Rooms {
  constructor(db) {
    this.db = db;
    /** id -> { doc, awareness, conns: Set<ws>, saveTimer } */
    this.rooms = new Map();
  }

  /** The live document, loading it from the database on first sight. */
  room(id) {
    let room = this.rooms.get(id);
    if (room) return room;
    const doc = new Y.Doc();
    const stored = this.db.loadDoc(id);
    if (stored) Y.applyUpdate(doc, stored);
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    room = { id, doc, awareness, conns: new Set(), saveTimer: null };

    doc.on("update", (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of room.conns) if (c !== origin) send(c, msg);
      if (room.saveTimer) clearTimeout(room.saveTimer);
      room.saveTimer = setTimeout(() => {
        room.saveTimer = null;
        this.db.saveDoc(id, Y.encodeStateAsUpdate(doc));
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

  /** The markdown the clients last serialised, for the read endpoint. */
  markdown(id) {
    const room = this.rooms.get(id);
    if (room) return room.doc.getMap("meta").get("markdown") ?? "";
    const stored = this.db.loadDoc(id);
    if (!stored) return "";
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored);
    const text = doc.getMap("meta").get("markdown") ?? "";
    doc.destroy();
    return text;
  }

  /** Tell everyone in the room what the review state is now. */
  announceReview(id, review) {
    const room = this.rooms.get(id);
    if (!room) return;
    const msg = reviewMessage(review);
    for (const c of room.conns) send(c, msg);
  }

  join(id, ws, review) {
    const room = this.room(id);
    room.conns.add(ws);
    ws.binaryType = "arraybuffer";
    /** Which awareness clients this socket spoke for, to clear on close. */
    const controlled = new Set();

    ws.on("message", (data) => {
      const bytes = new Uint8Array(data);
      const dec = decoding.createDecoder(bytes);
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
    });

    ws.on("close", () => {
      room.conns.delete(ws);
      awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
      if (room.conns.size === 0) {
        // The last reader left: write it out now and let the memory go.
        if (room.saveTimer) clearTimeout(room.saveTimer);
        room.saveTimer = null;
        this.db.saveDoc(id, Y.encodeStateAsUpdate(room.doc));
        room.awareness.destroy();
        room.doc.destroy();
        this.rooms.delete(id);
      }
    });

    // Open with our state vector, then everyone's presence, then the review.
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
    send(ws, reviewMessage(review));
  }

  /** Write everything out; called on shutdown. */
  flush() {
    for (const room of this.rooms.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      this.db.saveDoc(room.id, Y.encodeStateAsUpdate(room.doc));
    }
  }
}

function reviewMessage(review) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_REVIEW);
  encoding.writeVarString(enc, JSON.stringify(review));
  return encoding.toUint8Array(enc);
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(msg);
  } catch {
    ws.close();
  }
}
