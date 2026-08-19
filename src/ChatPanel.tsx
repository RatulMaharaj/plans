import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AgentCommand, type ChatId, type ConfigOption } from "./api";
import { track } from "./analytics";
import { AgentOptions } from "./AgentOptions";
import { Markdown } from "./chat-markdown";

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

/**
 * A line of the transcript.
 *
 * A union rather than a role and a string, because a tool call is not a
 * sentence: it arrives before it has finished and is amended afterwards, and
 * a permission request is a question with buttons. Flattening those into text
 * is what the old design did, and it is why a tool line could never stop
 * saying "running".
 */
type Msg =
  | { role: "user" | "assistant" | "thought"; text: string }
  | {
      role: "tool";
      callId: string;
      title: string;
      kind?: string;
      status?: string;
      locations?: string[];
    }
  | {
      role: "permission";
      requestId: string;
      title: string;
      options: { optionId: string; name: string; kind?: string }[];
      answered?: string | null;
    }
  /** Seams and failures: the app talking, not the agent. */
  | { role: "note"; text: string };

/** What the agent says it can do. Drawn, never interpreted. */
type Thread = {
  messages: Msg[];
  /** The plan *file* named to the agent most recently, so a change can be mentioned. */
  plan?: string | null;
  options?: ConfigOption[];
  commands?: AgentCommand[];
  /**
   * The agent's own session id, kept so a crashed or restarted process can be
   * asked to pick the conversation back up. Meaningless to a different agent,
   * which is why it is stored beside the transcript rather than in settings.
   */
  session?: string | null;
  /** The agent's own task list, when it keeps one. */
  todo?: { content: string; status?: string; priority?: string }[];
  usage?: { used: number; size: number; cost?: number };
};

type Props = {
  repo: string;
  /** The plan on screen. Context for the turn, not the key of the chat. */
  relPath: string | null;
  /** A message the app wants sent — "Hand off" arrives this way. */
  seed: string | null;
  onSeedUsed: () => void;
  /** Which agent from the catalogue; the argv is the Rust side's. */
  cmd: string;
  notify: (message: string, tone?: "error") => void;
  /** Dragging the panel's own edge; which edge that is depends on placement. */
  onResize: (e: React.PointerEvent<HTMLDivElement>) => void;
};

/*
 * v3: a fresh start per repository, and nothing carried across.
 *
 * v2 stored a Claude CLI session id, which means nothing to an ACP agent, and
 * flattened every tool call into grey text. An earlier version of this copied
 * those messages in as a record — but a transcript the agent has no memory of
 * is a conversation only on one side, and it filled the panel with something
 * that could not be continued. The old key is left on disk, untouched: not
 * shown is not the same as deleted.
 */
const keyOf = (repo: string) => `plans.chat.v3::${repo}`;

function load(key: string): Thread {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const t = JSON.parse(raw) as Thread;
      /*
       * A tool that was running when the window closed is not running now,
       * and a question nobody answered can no longer be answered — the
       * process it belonged to is gone. Left alone, the transcript would show
       * live-looking buttons wired to nothing.
       */
      t.messages = (t.messages ?? []).map((m) =>
        m.role === "tool" && (m.status === "pending" || m.status === "in_progress")
          ? { ...m, status: "interrupted" }
          : m.role === "permission" && m.answered === undefined
            ? { ...m, answered: null }
            : m,
      );
      return t;
    }
  } catch {
    // A malformed transcript is a fresh one, not a crash.
  }
  return { messages: [], plan: null };
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
  const [thread, setThread] = useState<Thread>({ messages: [], plan: null });
  const [input, setInput] = useState("");
  /** Which slash suggestion is highlighted, or -1 for "the list is closed". */
  const [pick, setPick] = useState(-1);
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
      setThread({ messages: [], plan: null });
      return;
    }
    const t = threads.current.get(key) ?? load(key);
    threads.current.set(key, t);
    setThread(t);
  }, [key]);

  /** Add to a transcript: a new bubble, or more of the one being written. */
  const say = useCallback(
    (k: string, role: "user" | "assistant" | "thought" | "note", text: string, append: boolean) =>
      commit(k, (t) => {
        const m = [...t.messages];
        if (append) {
          // The turn's answer is one bubble: append to the message of this
          // role in the current turn — anything after the last user message —
          // so a tool line arriving mid-stream does not split the prose in two.
          for (let i = m.length - 1; i >= 0 && m[i].role !== "user"; i--) {
            const at = m[i];
            if (at.role === role && "text" in at) {
              m[i] = { role, text: at.text + text };
              return { ...t, messages: m };
            }
          }
        }
        m.push({ role, text });
        return { ...t, messages: m };
      }),
    [commit],
  );

  /**
   * A tool call, which arrives more than once.
   *
   * The same backwards scan as `say`, matching on `callId` instead of role:
   * the first notification names the tool, later ones carry its status and
   * what it touched. Amending in place is the only way a line can go from
   * running to done — the old design appended, so it never could.
   */
  const upsertTool = useCallback(
    (k: string, patch: Partial<Extract<Msg, { role: "tool" }>> & { callId: string }) =>
      commit(k, (t) => {
        const m = [...t.messages];
        for (let i = m.length - 1; i >= 0; i--) {
          const at = m[i];
          if (at.role === "tool" && at.callId === patch.callId) {
            // Nulls are "no news", not "unset": an update that carries only a
            // status must not blank the title the first one gave us.
            const merged = { ...at };
            for (const [kk, v] of Object.entries(patch)) {
              if (v !== null && v !== undefined) (merged as never as Record<string, unknown>)[kk] = v;
            }
            m[i] = merged;
            return { ...t, messages: m };
          }
        }
        m.push({ role: "tool", title: patch.title ?? "Working", ...patch });
        return { ...t, messages: m };
      }),
    [commit],
  );

  /*
   * One listener set for the panel's lifetime.
   *
   * Two kinds of event now. A turn's narration is filtered by turn id, as
   * before. But the session outlives the turn, so what the agent *is* — its
   * options, its commands, its usage — arrives with a repo and no turn, and
   * has to be accepted whenever it comes.
   */
  useEffect(() => {
    const mine = (repoOf: string) => repoOf === repo;

    const message = listen<{ repo: string; turn: number; text: string }>("agent-message", (e) => {
      if (e.payload.turn !== turn.current?.id) return;
      say(turn.current.key, "assistant", e.payload.text, true);
    });
    const thought = listen<{ repo: string; turn: number; text: string }>("agent-thought", (e) => {
      if (e.payload.turn !== turn.current?.id) return;
      say(turn.current.key, "thought", e.payload.text, true);
    });
    const tool = listen<{
      repo: string;
      turn: number;
      callId: string;
      title: string | null;
      kind: string | null;
      status: string | null;
      locations: string[] | null;
    }>("agent-tool", (e) => {
      if (e.payload.turn !== turn.current?.id) return;
      const { callId, title, kind, status, locations } = e.payload;
      upsertTool(turn.current.key, {
        callId,
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(locations ? { locations } : {}),
      });
    });
    const ended = listen<{ repo: string; turn: number; stop: string; ok: boolean }>(
      "agent-turn",
      (e) => {
        if (e.payload.turn !== turn.current?.id) return;
        const k = turn.current.key;
        track("chat_turn_finished", {
          ok: e.payload.ok,
          seconds: Math.round((Date.now() - turn.current.at) / 1000),
        });
        turn.current = null;
        setBusy(false);
        if (!e.payload.ok) say(k, "note", `stopped — ${e.payload.stop}`, false);
      },
    );

    // Session-scoped: no turn to match, so the repo is the filter.
    const config = listen<{ repo: string; options: ConfigOption[] }>("agent-config", (e) => {
      if (!mine(e.payload.repo) || !key) return;
      commit(key, (t) => ({ ...t, options: e.payload.options ?? [] }));
    });
    const commands = listen<{ repo: string; commands: AgentCommand[] }>("agent-commands", (e) => {
      if (!mine(e.payload.repo) || !key) return;
      commit(key, (t) => ({ ...t, commands: e.payload.commands ?? [] }));
    });
    const usage = listen<{ repo: string; used: number; size: number; cost?: number }>(
      "agent-usage",
      (e) => {
        if (!mine(e.payload.repo) || !key) return;
        const { used, size, cost } = e.payload;
        commit(key, (t) => ({ ...t, usage: { used, size, cost } }));
      },
    );
    const asked = listen<{
      repo: string;
      requestId: string;
      title: string;
      options: { optionId: string; name: string; kind?: string }[];
    }>("agent-permission", (e) => {
      if (!mine(e.payload.repo) || !key) return;
      const { requestId, title, options } = e.payload;
      commit(key, (t) => ({
        ...t,
        messages: [...t.messages, { role: "permission", requestId, title, options }],
      }));
    });
    const answeredElsewhere = listen<{ repo: string; requestId: string; chosen: string | null }>(
      "agent-permission-done",
      (e) => {
        if (!mine(e.payload.repo) || !key) return;
        commit(key, (t) => ({
          ...t,
          messages: t.messages.map((m) =>
            m.role === "permission" && m.requestId === e.payload.requestId
              ? { ...m, answered: e.payload.chosen }
              : m,
          ),
        }));
      },
    );
    const opened = listen<{ repo: string; sessionId: string }>("agent-session", (e) => {
      if (!mine(e.payload.repo) || !key) return;
      commit(key, (t) => ({ ...t, session: e.payload.sessionId }));
    });
    const plan = listen<{ repo: string; entries: Thread["todo"] }>("agent-plan", (e) => {
      if (!mine(e.payload.repo) || !key) return;
      commit(key, (t) => ({ ...t, todo: e.payload.entries ?? [] }));
    });
    const down = listen<{ repo: string; message: string }>("agent-down", (e) => {
      if (!mine(e.payload.repo) || !key) return;
      turn.current = null;
      setBusy(false);
      if (e.payload.message) say(key, "note", `the agent stopped — ${e.payload.message}`, false);
    });

    return () => {
      for (const u of [
        message,
        thought,
        tool,
        ended,
        config,
        commands,
        usage,
        asked,
        answeredElsewhere,
        opened,
        plan,
        down,
      ])
        void u.then((f) => f());
    };
  }, [say, upsertTool, commit, key, repo]);

  const send = useCallback(
    async (text: string, seeded = false) => {
      if (!key || !text.trim() || turn.current || inflight.current) return;
      inflight.current = true;
      const t = threads.current.get(key) ?? load(key);
      /*
       * Which plan you are looking at, said when it changes.
       *
       * The repository no longer needs saying at all: `session/new` is given
       * the cwd, so the agent already knows where it is. That preamble was
       * something the old design had to send because a `-p` invocation had no
       * other way to say it.
       */
      const moved = relPath && relPath !== t.plan;
      const where = moved ? `The plan I am looking at is ${relPath}.\n\n` : "";
      commit(key, (cur) => ({
        ...cur,
        plan: relPath ?? cur.plan ?? null,
        messages: [...cur.messages, { role: "user", text }],
      }));
      setBusy(true);
      // The length and whether a button wrote it — never the message itself.
      track("chat_message_sent", { seeded, chars: text.length });
      try {
        // The session id, if there is one: a process that died between turns
        // is asked to pick the conversation back up rather than start over.
        const id = await api.agentPrompt(repo, cmd, where + text, t.session);
        turn.current = { id, key, at: Date.now() };
      } catch (e) {
        setBusy(false);
        // In the transcript as well as the toast: a turn that produced nothing
        // must not look like a turn that is still thinking, and a toast is
        // gone by the time you look back at the conversation.
        say(key, "note", String(e).replace(/^Error:\s*/, ""), false);
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
    if (turn.current) void api.agentCancel(repo, turn.current.id).catch(() => {});
  };

  /** Answer a permission request from the transcript. */
  const decide = (requestId: string, optionId: string | null) => {
    void api.agentPermission(repo, requestId, optionId).catch(() => {});
  };

  /*
   * Slash commands, which are not a feature so much as a filter.
   *
   * The agent advertises them and parses them itself — a command is ordinary
   * prompt text that happens to start with "/". All this does is help you
   * type one, which is why it needs no backend call and no state beyond the
   * highlight.
   */
  const slash = /^\/(\S*)$/.exec(input);
  const suggestions =
    slash && thread.commands?.length
      ? thread.commands
          .filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase()))
          .slice(0, 8)
      : [];

  const complete = (name: string) => {
    setInput(`/${name} `);
    setPick(-1);
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

      <AgentOptions repo={repo} options={thread.options} busy={busy} />

      {/* The agent's own task list, when it keeps one — its plan for the
          answer, not one of ours. */}
      {thread.todo?.length ? (
        <ol className="chat-todo">
          {thread.todo.map((t, i) => (
            <li key={i} className={t.status ?? "pending"}>
              {t.content}
            </li>
          ))}
        </ol>
      ) : null}

      <div className="chat-log" ref={logRef}>
        {thread.messages.length === 0 && (
          <div className="chat-hint">
            {relPath
              ? "Ask for anything — the agent can read and edit this repository."
              : "Ask for anything about this repository."}
          </div>
        )}
        {thread.messages.map((m, i) => {
          if (m.role === "tool") {
            return (
              <div key={i} className={`chat-tool ${m.status ?? "pending"}`}>
                <span className="chat-tool-dot" aria-hidden />
                {m.title}
                {m.locations?.length ? <span className="chat-where"> {m.locations.join(", ")}</span> : null}
              </div>
            );
          }
          if (m.role === "permission") {
            // Answered questions freeze into a statement: a button you can
            // press again after the agent has moved on is a lie.
            return (
              <div key={i} className="chat-ask">
                <span className="chat-ask-title">{m.title || "May I?"}</span>
                {m.answered === undefined ? (
                  <span className="chat-ask-acts">
                    {m.options.map((o) => (
                      <button key={o.optionId} className="act" onClick={() => decide(m.requestId, o.optionId)}>
                        {o.name}
                      </button>
                    ))}
                    <button className="act quiet" onClick={() => decide(m.requestId, null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="chat-ask-was">
                    {m.answered
                      ? (m.options.find((o) => o.optionId === m.answered)?.name ?? "allowed")
                      : "cancelled"}
                  </span>
                )}
              </div>
            );
          }
          if (m.role === "thought") {
            return (
              <details key={i} className="chat-thought">
                <summary>thinking</summary>
                {m.text}
              </details>
            );
          }
          if (m.role === "note") {
            return (
              <div key={i} className="chat-tool">
                {m.text}
              </div>
            );
          }
          return (
            <div key={i} className={`chat-msg ${m.role}`}>
              {/* Only the agent's prose is rendered: what you typed is shown
                  as you typed it, asterisks and all. */}
              {m.role === "assistant" ? <Markdown text={m.text} /> : m.text}
            </div>
          );
        })}
        {thinking && <div className="chat-tool">thinking…</div>}
      </div>

      <div className="chat-input">
        {suggestions.length > 0 && (
          <div className="chat-slash" role="listbox">
            {suggestions.map((c, i) => (
              <button
                key={c.name}
                className={`chat-slash-item ${i === pick ? "on" : ""}`}
                onMouseMove={() => setPick(i)}
                onClick={() => complete(c.name)}
              >
                <span className="chat-slash-name">/{c.name}</span>
                <span className="chat-slash-desc">{c.description ?? c.input?.hint ?? ""}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          rows={1}
          value={input}
          placeholder="Ask the agent…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // The conversation's keys, not the app's — but chords stay the
            // app's (⌘J must still close the panel), and Escape still leaves.
            if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
            // The list owns the arrows and Tab while it is open, and Enter
            // when something in it is chosen — otherwise Enter still sends,
            // because typing "/" and meaning it is allowed.
            if (suggestions.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const d = e.key === "ArrowDown" ? 1 : -1;
                setPick((i) => (i + d + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && pick >= 0)) {
                e.preventDefault();
                complete(suggestions[Math.max(0, pick)].name);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = input;
              setInput("");
              setPick(-1);
              void send(text);
            } else if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        <span className="chat-note">
          {thread.usage
            ? `${Math.round((thread.usage.used / Math.max(1, thread.usage.size)) * 100)}% of context` +
              (thread.usage.cost ? ` · $${thread.usage.cost.toFixed(2)}` : "")
            : "Edits land in the files — see Git for what changed."}
        </span>
      </div>
    </section>
  );
}
