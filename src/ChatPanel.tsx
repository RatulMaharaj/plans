import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AgentCommand, type ChatId, type ConfigOption } from "./api";
import { SKILLS } from "./skill";
import { track } from "./analytics";
import { AgentOptions } from "./AgentOptions";
import { chatKey, type ChatRef, type Index } from "./chats";
import { Markdown } from "./chat-markdown";
import { Dropdown } from "./Dropdown";

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
  /** Which agent that session id belongs to. It means nothing to another. */
  agent?: string | null;
  /** The agent's own task list, when it keeps one. */
  todo?: { content: string; status?: string; priority?: string }[];
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
  /** The repository's conversations, which App owns so the palette can too. */
  chats: Index;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string) => void;
  /** A chat names itself after the first thing said in it. */
  onTitle: (id: string, title: string) => void;
  /** Which conversations have a live agent, by `repo::chat`. */
  running: Record<string, number>;
  /** What to tell someone whose agent will not start. */
  authHint: string;
};

/*
 * v4: several conversations per repository, and an index of them.
 *
 * v3 kept exactly one, which made "start again" a thing you could only do by
 * forgetting — and `/clear` looked broken, because it clears the *agent's*
 * context while the transcript, which is ours, stayed on screen. A chat you
 * can leave and come back to is the honest shape: the agent's session and our
 * record of it begin and end together.
 *
 * The index is App's, in `chats.ts`, because the palette offers the same
 * conversations this panel's picker does. Transcripts stay here.
 *
 * Earlier keys are left on disk, untouched. Not shown is not the same as
 * deleted.
 */

/**
 * A conversation's name, taken from the first thing said in it.
 *
 * Not asked for and not editable: naming a chat is a chore, and the first
 * question is almost always what it was about.
 */
function titleOf(t: Thread): string {
  const first = t.messages.find((m) => m.role === "user");
  const text = first && "text" in first ? first.text.trim().replace(/\s+/g, " ") : "";
  if (!text) return "New chat";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

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
  chats,
  onNewChat,
  onOpenChat,
  onDeleteChat,
  onRenameChat,
  onTitle,
  running,
  authHint,
}: Props) {
  const key = repo && chats.current ? chatKey(repo, chats.current) : null;
  const [thread, setThread] = useState<Thread>({ messages: [], plan: null });
  const [input, setInput] = useState("");
  /** Which slash suggestion is highlighted, or -1 for "the list is closed". */
  const [pick, setPick] = useState(-1);
  /**
   * The turn in flight in each conversation, by thread key.
   *
   * A map rather than a single value, and that is the whole of what lets two
   * agents run: there was one turn ref, nulled whenever the panel changed
   * chats, so a conversation you navigated away from had nowhere to put its
   * answer. Its narration was not merely hidden — it was dropped, permanently,
   * including after coming back.
   */
  const turns = useRef(new Map<string, { id: ChatId; at: number }>());
  /**
   * The newest session this repository has had.
   *
   * `agent-down` arrives twice for one stop — once the moment the session is
   * told to go, and once when its task has actually finished, which is
   * arbitrarily later. By then a *different* session may be running, and an
   * unstamped farewell is indistinguishable from news about that one: it
   * cleared the live turn, after which the running agent's answer went
   * nowhere. Anything older than this is news about something already over.
   *
   * By chat, since a repository now has one of these per conversation.
   */
  const gen = useRef(new Map<string, number>());
  /**
   * Which conversations have a turn in flight.
   *
   * Per chat, so a long job running in one does not disable the composer in
   * another. `busy` below is only this panel's view of the chat on screen.
   */
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const busy = !!key && working.has(key);
  const mark = useCallback((k: string, on: boolean) => {
    setWorking((prev) => {
      if (prev.has(k) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  }, []);
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

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
  /** Through a ref: `commit` has no deps, and should not gain any. */
  const titleRef = useRef<Props["onTitle"] | null>(null);
  titleRef.current = onTitle;

  const commit = useCallback((k: string, up: (t: Thread) => Thread) => {
    const cur = threads.current.get(k) ?? load(k);
    const next = up(cur);
    threads.current.set(k, next);
    localStorage.setItem(k, JSON.stringify(next));
    // The name follows the first thing said, so a chat stops being called
    // "New chat" the moment it is about something. Reported upward: the index
    // belongs to App, which is where the palette reads it from.
    const id = k.split("::").pop();
    if (id) titleRef.current?.(id, titleOf(next));
    if (keyRef.current === k) setThread(next);
  }, []);

  // Switching repositories, or chats, switches conversations — mid-stream or not.
  useEffect(() => {
    keyRef.current = key;
    if (!key) {
      setThread({ messages: [], plan: null });
      return;
    }
    const t = threads.current.get(key) ?? load(key);
    threads.current.set(key, t);
    setThread(t);
    /*
     * Nothing is reset here any more.
     *
     * A turn belonging to the chat you just left is still that chat's, and is
     * still arriving — it now has a place to arrive at. Clearing state on a
     * switch is exactly what made a backgrounded conversation lose its answer.
     */
  }, [key]);

  /** Add to a transcript: a new bubble, or more of the one being written. */
  const say = useCallback(
    (k: string, role: "user" | "assistant" | "thought" | "note", text: string, append: boolean) =>
      commit(k, (t) => {
        const m = [...t.messages];
        if (append) {
          /*
           * Streamed text grows the bubble it is streaming into — but only
           * while that bubble is still the last thing in the transcript.
           * Reaching back past tool lines glued a turn's closing answer onto
           * the prose *above* the tools, so the answer was never the last
           * thing on screen. Prose, tools, prose is three sections in the
           * order they happened; render it that way.
           */
          const at = m[m.length - 1];
          if (at && at.role === role && "text" in at) {
            m[m.length - 1] = { role, text: at.text + text };
            return { ...t, messages: m };
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

    /*
     * Which transcript an event belongs to, from the event itself.
     *
     * Narration used to be matched against the one turn the panel had in hand,
     * which meant it could only ever reach the conversation on screen. Every
     * payload now names its chat, so a turn running in a chat you are not
     * looking at writes into that chat — `commit` persists threads whether or
     * not they are the one being rendered, which is what makes that work.
     */
    const to = (payload: { repo: string; chat?: string; turn?: number }) => {
      if (!mine(payload.repo) || !payload.chat) return null;
      const k = chatKey(payload.repo, payload.chat);
      // A turn id from a session this chat has moved on from.
      if (payload.turn !== undefined && turns.current.get(k)?.id !== payload.turn) return null;
      return k;
    };

    const message = listen<{ repo: string; chat: string; turn: number; text: string }>(
      "agent-message",
      (e) => {
        const k = to(e.payload);
        if (k) say(k, "assistant", e.payload.text, true);
      },
    );
    const thought = listen<{ repo: string; chat: string; turn: number; text: string }>(
      "agent-thought",
      (e) => {
        const k = to(e.payload);
        if (k) say(k, "thought", e.payload.text, true);
      },
    );
    const tool = listen<{
      repo: string;
      chat: string;
      turn: number;
      callId: string;
      title: string | null;
      kind: string | null;
      status: string | null;
      locations: string[] | null;
    }>("agent-tool", (e) => {
      const k = to(e.payload);
      if (!k) return;
      const { callId, title, kind, status, locations } = e.payload;
      upsertTool(k, {
        callId,
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(locations ? { locations } : {}),
      });
    });
    const ended = listen<{
      repo: string;
      chat: string;
      turn: number;
      stop: string;
      ok: boolean;
    }>("agent-turn", (e) => {
      const k = to(e.payload);
      if (!k) return;
      const at = turns.current.get(k)?.at ?? Date.now();
      track("chat_turn_finished", {
        ok: e.payload.ok,
        seconds: Math.round((Date.now() - at) / 1000),
      });
      turns.current.delete(k);
      mark(k, false);
      if (!e.payload.ok) say(k, "note", `stopped — ${e.payload.stop}`, false);
    });

    // Session-scoped: no turn to match, so the repo is the filter.
    /*
     * Session-scoped events — what the agent *is*, rather than what it is
     * saying. They carry no turn, and they too belong to a conversation rather
     * than to whichever one happens to be on screen: with two sessions live,
     * writing these into the visible transcript would put one agent's model
     * list and permission requests into the other's.
     */
    const config = listen<{ repo: string; chat: string; options: ConfigOption[] }>(
      "agent-config",
      (e) => {
        const k = to(e.payload);
        if (k) commit(k, (t) => ({ ...t, options: e.payload.options ?? [] }));
      },
    );
    const commands = listen<{ repo: string; chat: string; commands: AgentCommand[] }>(
      "agent-commands",
      (e) => {
        const k = to(e.payload);
        if (k) commit(k, (t) => ({ ...t, commands: e.payload.commands ?? [] }));
      },
    );
    const asked = listen<{
      repo: string;
      chat: string;
      requestId: string;
      title: string;
      options: { optionId: string; name: string; kind?: string }[];
    }>("agent-permission", (e) => {
      const k = to(e.payload);
      if (!k) return;
      const { requestId, title, options } = e.payload;
      // Into its own transcript, so a question asked by a chat you are not
      // looking at is waiting there when you arrive rather than lost.
      commit(k, (t) => ({
        ...t,
        messages: [...t.messages, { role: "permission", requestId, title, options }],
      }));
    });
    const answeredElsewhere = listen<{
      repo: string;
      chat: string;
      requestId: string;
      chosen: string | null;
    }>("agent-permission-done", (e) => {
      const k = to(e.payload);
      if (!k) return;
      commit(k, (t) => ({
        ...t,
        messages: t.messages.map((m) =>
          m.role === "permission" && m.requestId === e.payload.requestId
            ? { ...m, answered: e.payload.chosen }
            : m,
        ),
      }));
    });
    const opened = listen<{ repo: string; chat: string; sessionId: string }>(
      "agent-session",
      (e) => {
        const k = to(e.payload);
        if (k) commit(k, (t) => ({ ...t, session: e.payload.sessionId }));
      },
    );
    const plan = listen<{ repo: string; chat: string; entries: Thread["todo"] }>(
      "agent-plan",
      (e) => {
        const k = to(e.payload);
        if (k) commit(k, (t) => ({ ...t, todo: e.payload.entries ?? [] }));
      },
    );
    const ready = listen<{ repo: string; chat: string; gen: number }>("agent-ready", (e) => {
      const k = to(e.payload);
      if (k) gen.current.set(k, e.payload.gen);
    });
    const down = listen<{ repo: string; chat: string; gen: number; message: string }>(
      "agent-down",
      (e) => {
      const k = to(e.payload);
      if (!k) return;
      // A farewell from a session that has already been replaced.
      if (e.payload.gen && e.payload.gen < (gen.current.get(k) ?? 0)) return;
      turns.current.delete(k);
      mark(k, false);
      if (!e.payload.message) return;
      /*
       * The message the agent leaves is true and rarely actionable, so a
       * second line says what to do — but only when it fits.
       *
       * A signed-out agent and an agent that never started look nothing alike
       * and need opposite advice. "exit status: 127" or a missing binary is
       * the process failing to launch, and telling someone to sign in when
       * node could not be found sends them to fix the wrong thing.
       */
      const why = e.payload.message;
      say(k, "note", `the agent stopped — ${why}`, false);
      const missing = /127|No such file|not found|ENOENT/i.test(why);
      if (missing) {
        say(
          k,
          "note",
          "That is the agent failing to start, not a sign-in problem — it could not find what it needs on the PATH. Installing it from Settings → Agents runs it directly instead of through npx.",
          false,
        );
      } else if (authHint) {
        say(k, "note", authHint, false);
      }
      },
    );

    return () => {
      for (const u of [
        message,
        thought,
        tool,
        ended,
        config,
        commands,
        asked,
        answeredElsewhere,
        opened,
        plan,
        ready,
        down,
      ])
        void u.then((f) => f());
    };
  }, [say, upsertTool, commit, key, repo, authHint]);

  const send = useCallback(
    async (text: string, seeded = false) => {
      // Per chat: a long job running in another conversation is not a reason
      // to refuse this one.
      if (!key || !text.trim() || turns.current.has(key) || inflight.current) return;
      /*
       * `/clear` means what it says, here.
       *
       * Sent on to the agent it clears the agent's context and leaves our
       * transcript untouched, which looks exactly like nothing happening. It
       * is the same intent as New chat, so it is the same action — and the
       * agent's session ends with it rather than being asked to forget.
       *
       * The stop is explicit now. New chat no longer ends anything, so without
       * it `/clear` would start a fresh conversation and leave the process it
       * was clearing running with nothing pointing at it.
       */
      if (text.trim() === "/clear") {
        void api.agentStop(repo, chats.current).catch(() => {});
        onNewChat();
        return;
      }
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
      mark(key, true);
      // The length and whether a button wrote it — never the message itself.
      track("chat_message_sent", { seeded, chars: text.length });
      try {
        /*
         * The session id, if there is one worth offering.
         *
         * A session belongs to the agent that opened it, so switching agents
         * drops it: asking Codex to resume a Claude session is asking for a
         * refusal at best. The transcript stays — it is what was said — but
         * the new agent starts without it, and the note says so.
         */
        const same = !t.agent || t.agent === cmd;
        /*
         * The app's own slash commands: /plans and /review carry a bundled
         * skill. The transcript keeps what was typed; what travels is the
         * skill's text with the rest of the message under it — the agent
         * needs no install in this repository to know the conventions.
         */
        const skill = /^\/(\w+)\b\s*([\s\S]*)$/.exec(text);
        const bundled = skill && SKILLS.find((k) => k.name === skill[1]);
        const outgoing = bundled
          ? `${bundled.text.trim()}\n\n---\n\n${
              skill[2].trim() || "Apply the skill above in this repository."
            }`
          : text;
        const id = await api.agentPrompt(
          repo,
          chats.current,
          cmd,
          where + outgoing,
          same ? t.session : null,
        );
        if (!same) {
          commit(key, (cur) => ({
            ...cur,
            session: null,
            messages: [
              ...cur.messages,
              { role: "note", text: `Switched to ${cmd} — it starts without the conversation above.` },
            ],
          }));
        }
        commit(key, (cur) => ({ ...cur, agent: cmd }));
        turns.current.set(key, { id, at: Date.now() });
      } catch (e) {
        mark(key, false);
        // In the transcript as well as the toast: a turn that produced nothing
        // must not look like a turn that is still thinking, and a toast is
        // gone by the time you look back at the conversation.
        say(key, "note", String(e).replace(/^Error:\s*/, ""), false);
        notify(String(e), "error");
      } finally {
        inflight.current = false;
      }
    },
    [key, relPath, repo, cmd, chats.current, commit, notify, say, onNewChat, mark],
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

  /** Stop belongs to the conversation it is in, not to whatever ran last. */
  const stop = () => {
    const at = key && turns.current.get(key);
    if (at) void api.agentCancel(repo, chats.current, at.id).catch(() => {});
  };

  /** Answer a permission request from the transcript. */
  const decide = (requestId: string, optionId: string | null) => {
    void api.agentPermission(repo, chats.current, requestId, optionId).catch(() => {});
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
  // The app's skills come first: they work with every agent, installed or not.
  const skillCommands: AgentCommand[] = SKILLS.map((k) => ({
    name: k.name,
    description: `Plans ${k.label} — sent along with your message`,
  }));
  const suggestions = slash
    ? [
        ...skillCommands,
        // An agent's own command with a skill's name would never run — the
        // transform catches the text first — so it is not offered twice.
        ...(thread.commands ?? []).filter(
          (c) => !skillCommands.some((k) => k.name === c.name),
        ),
      ]
        .filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase()))
        .slice(0, 8)
    : [];

  const complete = (name: string) => {
    setInput(`/${name} `);
    setPick(-1);
  };

  /*
   * The box grows with what you are writing.
   *
   * Three lines to start, because a one-line box makes anything worth asking
   * an agent look like it does not fit. It then follows the text up to a
   * ceiling, past which it scrolls: a message long enough to swallow the
   * conversation should not be allowed to.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [input]);

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
        {/*
          * The chat names itself, from the first thing said in it. The
          * repository is in the rail and the plan is in the status bar, so
          * neither needs repeating here — what the header is for is knowing
          * which conversation you are in, and leaving it.
          */}
        {chats.list.length > 1 ? (
          <Dropdown
            className="chat-pick"
            ariaLabel="Conversation"
            value={chats.current}
            onChange={onOpenChat}
            /*
             * Running first, finished under a rule.
             *
             * A chat is active because a process exists behind it and archived
             * because none does — a fact rather than a policy, so it needs no
             * timer and no flag anyone has to remember to set. The Dropdown
             * already has both affordances this wants: a note on the right, and
             * one row set apart, which is all a divider has to be.
             */
            choices={(() => {
              const live = chats.list.filter((c: ChatRef) => running[`${repo}::${c.id}`]);
              const rest = chats.list.filter((c: ChatRef) => !running[`${repo}::${c.id}`]);
              return [
                ...live.map((c: ChatRef) => ({ value: c.id, label: c.title, note: "running" })),
                ...rest.map((c: ChatRef, i: number) => ({
                  value: c.id,
                  label: c.title,
                  // Only the first, and only when there is something above it
                  // to be set apart from.
                  apart: i === 0 && live.length > 0,
                })),
              ];
            })()}
          />
        ) : (
          <span className="chat-title">{chats.list[0]?.title ?? "New chat"}</span>
        )}
        <span className="mux-spacer" />
        <button
          className="mux-key"
          onClick={() => onRenameChat(chats.current)}
          title="Rename this conversation"
          aria-label="Rename this conversation"
        >
          Rename
        </button>
        <button
          className="mux-key"
          onClick={() => onDeleteChat(chats.current)}
          title="Delete this conversation"
          aria-label="Delete this conversation"
        >
          Delete
        </button>
        <button
          className="mux-key"
          onClick={onNewChat}
          title="Start a new conversation (the agent forgets this one)"
        >
          New
        </button>
      </div>

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
        {/* Stop lives with the composer, floating clear of the title — the
            answer is stopped where the next message is typed, and Esc in the
            box does the same. */}
        {busy && (
          <button className="chat-stop" onClick={stop} title="Stop this answer (esc)">
            Stop
          </button>
        )}
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
          ref={boxRef}
          rows={3}
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
              // While the agent is working, Escape means "stop" — the same
              // gesture every terminal agent teaches. Idle, it leaves the box.
              if (busy) stop();
              else (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        {/*
          * Under the box you type in, not above the transcript.
          *
          * Which model and how hard it thinks are decisions about the message
          * you are about to send, so they belong with the message. At the top
          * of the panel they read as a status bar for the conversation, which
          * is the wrong thing entirely — they are not describing what was
          * said, they are setting what happens next.
          */}
        <div className="chat-foot">
          <AgentOptions repo={repo} chat={chats.current} options={thread.options} busy={busy} />
        </div>
      </div>
    </section>
  );
}
