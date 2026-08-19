/**
 * The conversations a repository has had.
 *
 * Only the index lives here — which chats exist, what they are called, which
 * one is on screen. The transcripts stay with the panel that draws them; this
 * is the part two places need to agree on, since the palette offers the same
 * chats the panel's own picker does.
 */

export type ChatRef = { id: string; title: string; at: number };
export type Index = { current: string; list: ChatRef[] };

export const indexKey = (repo: string) => `plans.chats.v4::${repo}`;
export const chatKey = (repo: string, id: string) => `plans.chat.v4::${repo}::${id}`;

/** Ids only have to be unique within a repository, and readable in storage. */
export const newId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function saveIndex(repo: string, i: Index) {
  localStorage.setItem(indexKey(repo), JSON.stringify(i));
}

export function loadIndex(repo: string): Index {
  try {
    const raw = localStorage.getItem(indexKey(repo));
    if (raw) {
      const i = JSON.parse(raw) as Index;
      if (i.current && Array.isArray(i.list) && i.list.length) return i;
    }
  } catch {
    // A malformed index is a fresh one, not a crash.
  }
  /*
   * Written the moment it is invented.
   *
   * Otherwise every caller mints a different id for the same empty state, the
   * key moves under the panel, and a transcript is written to one address and
   * read from another — which looks like the agent saying nothing at all.
   */
  const id = newId();
  const made = { current: id, list: [{ id, title: "New chat", at: Date.now() }] };
  saveIndex(repo, made);
  return made;
}

/** A conversation nobody has said anything in yet. */
export function started(prev: Index): Index {
  const id = newId();
  return { current: id, list: [{ id, title: "New chat", at: Date.now() }, ...prev.list] };
}
