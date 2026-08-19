import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ChatId } from "./api";

/**
 * A conversation with the agent about the open plan.
 *
 * The machinery — a headless CLI run per turn, a session id carried between
 * turns — stays out of sight. What remains is the exchange: you type, the
 * answer streams in, and anything the agent does to files arrives through the
 * watcher and git the way every outside edit always has. The transcript
 * belongs to the plan, not to the panel: each (repo, plan) pair keeps its own
 * conversation, resumed when the plan is reopened.
 */

type Msg = {
  role: "user" | "assistant" | "tool";
  text: string;
};

type Thread = { messages: Msg[]; session: string | null };

type Props = {
  repo: string;
  /** The plan the conversation is about; the chat is per-plan on purpose. */
  relPath: string | null;
  /** A message the app wants sent — "Flesh out" arrives this way. */
  seed: string | null;
  onSeedUsed: () => void;
  /** The agent binary from settings; the flags are the Rust side's. */
  cmd: string;
  notify: (message: string, tone?: "error") => void;
};

const keyOf = (repo: string, rel: string) => `plans.chat.v1::${repo}::${rel}`;

function load(key: string): Thread {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Thread;
  } catch {
    // A malformed transcript is a fresh one, not a crash.
  }
  return { messages: [], session: null };
}

export function ChatPanel({ repo, relPath, seed, onSeedUsed, cmd, notify }: Props) {
  const key = relPath ? keyOf(repo, relPath) : null;
  const [thread, setThread] = useState<Thread>({ messages: [], session: null });
  const [input, setInput] = useState("");
  /** The turn in flight, if any, and which conversation it belongs to. */
  const turn = useRef<{ id: ChatId; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  /**
   * All threads this panel has touched, by key. Events land here first so a
   * turn that finishes after the user switched plans still reaches the right
   * transcript; state mirrors only the one on screen.
   */
  const threads = useRef(new Map<string, Thread>());
  const keyRef = useRef<string | null>(null);
  /** True from send() being entered until chat_send answers — a synchronous
   *  guard where turn.current has an async gap. */
  const inflight = useRef(false);

  const commit = useCallback((k: string, up: (t: Thread) => Thread) => {
    const cur = threads.current.get(k) ?? load(k);
    const next = up(cur);
    threads.current.set(k, next);
    localStorage.setItem(k, JSON.stringify(next));
    if (keyRef.current === k) setThread(next);
  }, []);

  // Switching plans switches conversations, mid-stream or not.
  useEffect(() => {
    keyRef.current = key;
    if (!key) {
      setThread({ messages: [], session: null });
      return;
    }
    const t = threads.current.get(key) ?? load(key);
    threads.current.set(key, t);
    setThread(t);
  }, [key]);

  // One listener set for the panel's lifetime; the turn ref says whose
  // events these are.
  useEffect(() => {
    const say = (k: string, role: Msg["role"], text: string, append: boolean) =>
      commit(k, (t) => {
        const m = [...t.messages];
        if (append) {
          // The turn's answer is one bubble: append to the assistant message
          // of the current turn — anything after the last user message — so a
          // tool line arriving mid-stream does not split the prose in two.
          for (let i = m.length - 1; i >= 0 && m[i].role !== "user"; i--) {
            if (m[i].role === role) {
              m[i] = { role, text: m[i].text + text };
              return { ...t, messages: m };
            }
          }
        }
        m.push({ role, text });
        return { ...t, messages: m };
      });

    const delta = listen<{ id: number; text: string }>("chat-delta", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      say(turn.current.key, "assistant", e.payload.text, true);
    });
    const tool = listen<{ id: number; name: string }>("chat-tool", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      say(turn.current.key, "tool", e.payload.name, false);
    });
    const done = listen<{ id: number; session: string | null; ok: boolean }>("chat-done", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      const k = turn.current.key;
      turn.current = null;
      setBusy(false);
      commit(k, (t) => ({ ...t, session: e.payload.session ?? t.session }));
    });
    const failed = listen<{ id: number; message: string }>("chat-error", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      const k = turn.current.key;
      turn.current = null;
      setBusy(false);
      say(k, "tool", `stopped — ${e.payload.message || "no answer"}`, false);
    });
    return () => {
      for (const u of [delta, tool, done, failed]) void u.then((f) => f());
    };
  }, [commit]);

  const send = useCallback(
    async (text: string) => {
      if (!key || !relPath || !text.trim() || turn.current || inflight.current) return;
      inflight.current = true;
      const t = threads.current.get(key) ?? load(key);
      // The plan's identity rides the first turn; --resume carries it after.
      const preamble = t.session
        ? ""
        : `You are working in the repository at ${repo}. ` +
          `The plan under discussion is ${relPath}. ` +
          `Edit files directly when asked, and keep answers brief.\n\n`;
      commit(key, (cur) => ({ ...cur, messages: [...cur.messages, { role: "user", text }] }));
      setBusy(true);
      try {
        const id = await api.chatSend(repo, cmd, preamble + text, t.session);
        turn.current = { id, key };
      } catch (e) {
        setBusy(false);
        notify(String(e), "error");
      } finally {
        inflight.current = false;
      }
    },
    [key, relPath, repo, cmd, commit, notify],
  );

  // "Flesh out" and friends arrive as a seeded message, sent as if typed.
  // Consumed through a ref: the parent's state update that clears the seed
  // has not re-rendered yet when StrictMode runs this effect the second time.
  const seenSeed = useRef<string | null>(null);
  useEffect(() => {
    if (!seed || !key || seenSeed.current === seed) return;
    seenSeed.current = seed;
    onSeedUsed();
    void send(seed);
  }, [seed, key, send, onSeedUsed]);

  const stop = () => {
    if (turn.current) void api.chatCancel(turn.current.id).catch(() => {});
  };

  // A growing answer should stay in view, as a conversation would.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages]);

  const thinking = busy && thread.messages[thread.messages.length - 1]?.role === "user";

  return (
    <section className="mux chat" aria-label="Agent chat">
      <div className="mux-head">
        <span className="chat-title">{relPath ?? "Agent"}</span>
        <span className="mux-spacer" />
        {busy && (
          <button className="mux-key" onClick={stop} title="Stop this answer">
            Stop
          </button>
        )}
      </div>

      <div className="chat-log" ref={logRef}>
        {thread.messages.length === 0 && (
          <div className="chat-hint">
            {relPath
              ? "Ask for anything — the agent can read and edit this plan."
              : "Open a plan to talk about it."}
          </div>
        )}
        {thread.messages.map((m, i) =>
          m.role === "tool" ? (
            <div key={i} className="chat-tool">
              {m.text}
            </div>
          ) : (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.text}
            </div>
          ),
        )}
        {thinking && <div className="chat-tool">thinking…</div>}
      </div>

      <div className="chat-input">
        <textarea
          rows={1}
          value={input}
          disabled={!relPath}
          placeholder={relPath ? "Ask the agent…" : "Nothing open"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // The conversation's keys, not the app's — but chords stay the
            // app's (⌘J must still close the panel), and Escape still leaves.
            if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = input;
              setInput("");
              void send(text);
            } else if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        <span className="chat-note">Edits land in the files — see Git for what changed.</span>
      </div>
    </section>
  );
}
