import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ChatId } from "./api";
import { track } from "./analytics";

/**
 * A conversation with the agent about the open plan.
 *
 * The machinery — a headless CLI run per turn, a session id carried between
 * turns — stays out of sight. What remains is the exchange: you type, the
 * answer streams in, and anything the agent does to files arrives through the
 * watcher and git the way every outside edit always has.
 *
 * The transcript belongs to the *repository*. One conversation per repo, not
 * per file: people do not think about a plan in isolation, they think about
 * the work, and a chat that resets every time you click another file forgets
 * what you were doing for no reason the agent shares. Which plan is open is
 * still said — it rides the turn as a line of context whenever it changes —
 * but it does not partition the conversation.
 */

type Msg = {
  role: "user" | "assistant" | "tool";
  text: string;
};

type Thread = {
  messages: Msg[];
  session: string | null;
  /** The plan named to the agent most recently, so a change can be mentioned. */
  plan?: string | null;
};

type Props = {
  repo: string;
  /** The plan on screen. Context for the turn, not the key of the chat. */
  relPath: string | null;
  /** A message the app wants sent — "Hand off" arrives this way. */
  seed: string | null;
  onSeedUsed: () => void;
  /** The agent binary from settings; the flags are the Rust side's. */
  cmd: string;
  notify: (message: string, tone?: "error") => void;
  /** Dragging the panel's own edge; which edge that is depends on placement. */
  onResize: (e: React.PointerEvent<HTMLDivElement>) => void;
};

/*
 * v2: v1 keyed on the plan as well, and those entries are left where they are
 * rather than merged. Concatenating several file-scoped transcripts into one
 * would produce a conversation nobody had, and the agent's own sessions are
 * per-transcript anyway — the honest migration is a fresh start per repo.
 */
const keyOf = (repo: string) => `plans.chat.v2::${repo}`;

function load(key: string): Thread {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Thread;
  } catch {
    // A malformed transcript is a fresh one, not a crash.
  }
  return { messages: [], session: null, plan: null };
}

export function ChatPanel({
  repo,
  relPath,
  seed,
  onSeedUsed,
  cmd,
  notify,
  onResize,
}: Props) {
  const key = repo ? keyOf(repo) : null;
  const [thread, setThread] = useState<Thread>({ messages: [], session: null, plan: null });
  const [input, setInput] = useState("");
  /** The turn in flight, if any, and which conversation it belongs to. */
  const turn = useRef<{ id: ChatId; key: string; at: number } | null>(null);
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

  // Switching repositories switches conversations, mid-stream or not.
  useEffect(() => {
    keyRef.current = key;
    if (!key) {
      setThread({ messages: [], session: null, plan: null });
      return;
    }
    const t = threads.current.get(key) ?? load(key);
    threads.current.set(key, t);
    setThread(t);
  }, [key]);

  /** Add to a transcript: a new bubble, or more of the one being written. */
  const say = useCallback(
    (k: string, role: Msg["role"], text: string, append: boolean) =>
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
      }),
    [commit],
  );

  // One listener set for the panel's lifetime; the turn ref says whose
  // events these are.
  useEffect(() => {
    const delta = listen<{ id: number; text: string }>("chat-delta", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      say(turn.current.key, "assistant", e.payload.text, true);
    });
    const tool = listen<{ id: number; name: string; detail: string }>("chat-tool", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      const { name, detail } = e.payload;
      say(turn.current.key, "tool", detail ? `${name} ${detail}` : name, false);
    });
    const done = listen<{ id: number; session: string | null; ok: boolean }>("chat-done", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      const k = turn.current.key;
      track("chat_turn_finished", {
        ok: e.payload.ok,
        seconds: Math.round((Date.now() - turn.current.at) / 1000),
      });
      turn.current = null;
      setBusy(false);
      commit(k, (t) => ({ ...t, session: e.payload.session ?? t.session }));
    });
    const failed = listen<{ id: number; message: string }>("chat-error", (e) => {
      if (e.payload.id !== turn.current?.id) return;
      const k = turn.current.key;
      track("chat_turn_finished", {
        ok: false,
        seconds: Math.round((Date.now() - turn.current.at) / 1000),
      });
      turn.current = null;
      setBusy(false);
      say(k, "tool", `stopped — ${e.payload.message || "no answer"}`, false);
    });
    return () => {
      for (const u of [delta, tool, done, failed]) void u.then((f) => f());
    };
  }, [say]);

  const send = useCallback(
    async (text: string, seeded = false) => {
      if (!key || !text.trim() || turn.current || inflight.current) return;
      inflight.current = true;
      const t = threads.current.get(key) ?? load(key);
      /*
       * Two kinds of context, and neither is repeated for its own sake.
       *
       * The repository is said once, on the turn that opens the session;
       * `--resume` carries it after that. The plan is said whenever it is not
       * the one the agent was last told about — which is the first turn, and
       * every turn after you click a different file. Saying it every time
       * would waste tokens and read as nagging in the transcript.
       */
      const opening = t.session
        ? ""
        : `You are working in the repository at ${repo}. ` +
          `Edit files directly when asked, and keep answers brief.\n\n`;
      const moved = relPath && relPath !== t.plan;
      const where = moved ? `The plan I am looking at is ${relPath}.\n\n` : "";
      commit(key, (cur) => ({
        ...cur,
        plan: relPath ?? cur.plan ?? null,
        messages: [...cur.messages, { role: "user", text }],
      }));
      setBusy(true);
      // The length and whether a button wrote it — never the message itself.
      track("chat_message_sent", { seeded, chars: text.length, resumed: !!t.session });
      try {
        const id = await api.chatSend(repo, cmd, opening + where + text, t.session);
        turn.current = { id, key, at: Date.now() };
      } catch (e) {
        setBusy(false);
        // In the transcript as well as the toast: a turn that produced nothing
        // must not look like a turn that is still thinking, and a toast is
        // gone by the time you look back at the conversation.
        say(key, "tool", String(e).replace(/^Error:\s*/, ""), false);
        notify(String(e), "error");
      } finally {
        inflight.current = false;
      }
    },
    [key, relPath, repo, cmd, commit, notify, say],
  );

  // "Hand off" and friends arrive as a seeded message, sent as if typed.
  // Consumed through a ref: the parent's state update that clears the seed
  // has not re-rendered yet when StrictMode runs this effect the second time.
  const seenSeed = useRef<string | null>(null);
  useEffect(() => {
    if (!seed || !key || seenSeed.current === seed) return;
    seenSeed.current = seed;
    onSeedUsed();
    void send(seed, true);
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
      {/* First child, so it sits over the panel's leading edge either way. */}
      <div className="chat-edge" onPointerDown={onResize} aria-hidden />
      <div className="panel-head">
        {/* The repository names the conversation; the plan is only what it
            is currently pointed at, and that changes under it. */}
        <span className="chat-title">{repo.split("/").pop() || "Agent"}</span>
        {relPath && <span className="chat-where">{relPath}</span>}
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
              ? "Ask for anything — the agent can read and edit this repository."
              : "Ask for anything about this repository."}
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
          placeholder="Ask the agent…"
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
