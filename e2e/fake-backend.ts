/**
 * A repository that lives in memory.
 *
 * Every Rust command the app calls is answered here, so the whole frontend —
 * tree, tabs, editor, palette, autosave, conflict detection — can be driven in
 * a real browser without a Tauri process or a filesystem. The boundary is the
 * `invoke` function, which is the same boundary src/api.ts wraps.
 *
 * The point is not to simulate git. It is to make the app's own behaviour
 * testable: what it reads, when it writes, and what it does when a file changes
 * underneath it.
 */

export type FakeFile = { content: string; stamp: number };

export type FakeRepo = {
  path: string;
  name: string;
  branch: string;
  files: Record<string, string>;
  /** Paths git should report as modified. */
  modified?: string[];
  /** Paths git should report as conflicted ("UU"). */
  conflicted?: string[];
  /** An unfinished "merge" or "rebase", as git_status reports one. */
  operation?: string;
};

/** A version the feed should claim is available, for the updater's own tests. */
export type FakeUpdate = { version: string; notes: string };

/** Installed before any app code runs, so the app never sees a real backend. */
export function installFakeBackend(repos: FakeRepo[], update?: FakeUpdate) {
  const state = {
    repos: repos.map((r) => ({ ...r, files: { ...r.files } })),
    /** Every command the app has issued, for asserting on writes. */
    calls: [] as { cmd: string; args: Record<string, unknown> }[],
    /**
     * Folders that exist with nothing in them. The fake filesystem is a map of
     * files, so an empty folder would otherwise vanish the moment it is made —
     * whereas on disk it is a real directory that `existing_dirs` can see.
     */
    dirs: new Set<string>(),
    /** Every question the app has put up, and the answer it will get. */
    asked: [] as string[],
    confirmAnswer: true,
    /** Set to a message to make the next chat_send reject with it. */
    failNextSend: null as string | null,
    /** Whether a second agent is installed, when a test wants one. */
    codex: null as string | null,
    /** Permission answers the app has sent back. */
    answered: [] as { requestId: string; option: string | null }[],
    /** The options the fake agent advertises; `agent_set_config` mutates it. */
    options: [] as Record<string, unknown>[],
    /** The installed `plans` script, null until one is installed. */
    cli: null as { path: string; current: boolean } | null,
    /** Whether the machine has tmux at all. */
    mux: true,
    /** Panes the fake tmux server is running. */
    panes: [] as any[],
    /** Whether the machine has an agent CLI to chat with. */
    chat: true,
    /** Chat turns still "running": id -> true, for asserting cancel. */
    chats: {} as Record<number, boolean>,
    /** Event listeners the app has registered, by event name and id. */
    listeners: {} as Record<string, { id: number; fn: (e: unknown) => void }[]>,
    /** Push an event at the app, as the Rust side would. */
    emit(event: string, payload: unknown) {
      for (const l of state.listeners[event] ?? []) l.fn({ event, id: 0, payload });
    },
  };
  let nextChat = 1;

  const hash = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `${h >>> 0}`;
  };
  const repo = (path: string) => state.repos.find((r) => r.path === path);

  const handlers: Record<string, (a: Record<string, any>) => unknown> = {
    open_repo: ({ path }) => {
      const r = repo(path);
      if (!r) throw new Error(`${path} is not inside a git repository`);
      return { path: r.path, name: r.name, branch: r.branch, plan_dirs: [] };
    },
    list_plans: ({ repo: p }) => {
      const r = repo(p);
      if (!r) return [];
      return Object.keys(r.files)
        .sort()
        .map((rel) => ({
          rel_path: rel,
          name: rel.split("/").pop(),
          dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
          modified: 0,
          // The real command reads `status:` out of the frontmatter; the tree
          // shows it and now filters on it, so the fake has to as well.
          status: /^---\r?\n([\s\S]*?)\r?\n---/
            .exec(r.files[rel] ?? "")?.[1]
            .split(/\r?\n/)
            .map((l) => /^status\s*:\s*(.+)$/.exec(l)?.[1]?.trim())
            .find(Boolean) ?? null,
        }));
    },
    read_plan: ({ repo: p, relPath }) => {
      const r = repo(p);
      const content = r?.files[relPath];
      if (content === undefined) throw new Error(`could not read ${relPath}`);
      return { content, stamp: hash(content) };
    },
    stat_plan: ({ repo: p, relPath }) => {
      const r = repo(p);
      const content = r?.files[relPath];
      return content === undefined ? "absent" : hash(content);
    },
    write_plan: ({ repo: p, relPath, content, expectStamp }) => {
      const r = repo(p);
      if (!r) throw new Error("no such repository");
      const now = r.files[relPath];
      if (expectStamp && now !== undefined && hash(now) !== expectStamp) throw new Error("STALE");
      r.files[relPath] = content;
      return hash(content);
    },
    create_plan: ({ repo: p, relPath, title }) => {
      const r = repo(p);
      if (!r) throw new Error("no such repository");
      if (r.files[relPath] !== undefined) throw new Error(`${relPath} already exists`);
      r.files[relPath] = `# ${title}\n\n`;
      return null;
    },
    delete_plan: ({ repo: p, relPath }) => {
      const r = repo(p);
      if (r) delete r.files[relPath];
      return null;
    },
    // A folder exists here if any file sits under it — the fake filesystem
    // has no directory entries of its own, exactly like the real one.
    existing_dirs: ({ repo: p, relPaths }) => {
      const r = repo(p);
      if (!r) return [];
      const files = Object.keys(r.files);
      return (relPaths as string[]).filter(
        (d) => state.dirs.has(`${p}::${d}`) || files.some((f) => f.startsWith(`${d}/`)),
      );
    },
    folder_census: ({ repo: p, relPath }) => {
      const r = repo(p);
      const under = Object.keys(r?.files ?? {}).filter((f) => f.startsWith(`${relPath}/`));
      return {
        files: under.length,
        hidden: under.filter((f) => !/\.(md|markdown)$/i.test(f)).length,
      };
    },
    delete_folder: ({ repo: p, relPath }) => {
      const r = repo(p);
      if (!r) throw new Error("no such repository");
      for (const f of Object.keys(r.files)) {
        if (f.startsWith(`${relPath}/`)) delete r.files[f];
      }
      for (const d of state.dirs) {
        if (d === `${p}::${relPath}` || d.startsWith(`${p}::${relPath}/`)) state.dirs.delete(d);
      }
      return null;
    },
    reveal_in_finder: () => null,
    // Git's idea of who you are, which is the only identity the app has. A
    // fixed answer, so a comment written in a test is attributed predictably.
    git_identity: () => ({ name: "Test Person", email: "test@example.com" }),
    create_folder: ({ repo: p, relPath }) => {
      const r = repo(p);
      if (!r) throw new Error("no such repository");
      // A folder is not a file; the fake filesystem only records that it exists.
      if (Object.keys(r.files).some((f) => f.startsWith(`${relPath}/`))) {
        throw new Error(`${relPath} already exists`);
      }
      state.dirs.add(`${p}::${relPath}`);
      return null;
    },
    rename_plan: ({ repo: p, from, to }) => {
      const r = repo(p);
      if (!r) throw new Error("no such repository");
      if (r.files[to] !== undefined) throw new Error(`${to} already exists`);

      // A file, or a folder and everything under it — fs::rename does both.
      if (r.files[from] !== undefined) {
        r.files[to] = r.files[from];
        delete r.files[from];
        return null;
      }
      const under = Object.keys(r.files).filter((f) => f.startsWith(`${from}/`));
      if (!under.length) throw new Error(`${from} does not exist`);
      for (const f of under) {
        r.files[`${to}${f.slice(from.length)}`] = r.files[f];
        delete r.files[f];
      }
      return null;
    },
    search_plans: ({ repo: p, query, limit }) => {
      const r = repo(p);
      const needle = String(query ?? "").trim().toLowerCase();
      if (!r || !needle) return [];
      const out: { rel_path: string; line: number; text: string }[] = [];
      for (const [rel, text] of Object.entries(r.files)) {
        text.split("\n").forEach((line, i) => {
          if (out.length >= (limit ?? 60)) return;
          if (line.toLowerCase().includes(needle)) {
            out.push({ rel_path: rel, line: i + 1, text: line.trim() });
          }
        });
      }
      return out;
    },
    write_asset: ({ repo: p, relPath, folder, stem, ext }) => {
      const r = repo(p);
      const dir = (folder || "assets").replace(/^\/+|\/+$/g, "");
      const name = `${stem}.${ext}`;
      if (r) r.files[`${dir}/${name}`] = "<binary>";
      // The link climbs out of the document's own folder, as markdown needs.
      const depth = (relPath.match(/\//g) ?? []).length;
      return `${"../".repeat(depth)}${dir}/${name}`;
    },
    git_status: ({ repo: p }) => {
      const r = repo(p);
      return {
        branch: r?.branch ?? "main",
        ahead: 0,
        behind: 0,
        has_upstream: true,
        operation: r?.operation ?? null,
        entries: [
          ...(r?.modified ?? []).map((path) => ({ path, index: " ", worktree: "M" })),
          ...(r?.conflicted ?? []).map((path) => ({ path, index: "U", worktree: "U" })),
        ],
      };
    },
    git_branches: ({ repo: p }) => ({
      current: repo(p)?.branch ?? "main",
      branches: [repo(p)?.branch ?? "main", "other"],
    }),
    read_asset: () => "data:image/png;base64,iVBORw0KGgo=",

    // tmux: present, with whatever panes the test asked for. A test that says
    // nothing gets an empty list, which is the same thing a machine with no
    // tmux server shows — the app must be happy with both.
    mux_available: () => (state.mux ? { kind: "tmux", version: "tmux 3.6b" } : null),
    mux_panes: ({ repo: p }) => (state.panes ?? []).filter((x: any) => x.path.startsWith(p)),
    mux_start: ({ repo: p, argv }) => {
      const id = `%${100 + (state.panes?.length ?? 0)}`;
      state.panes = [
        ...(state.panes ?? []),
        { id, target: `plans:${(state.panes?.length ?? 0) + 1}`, command: argv[0], dead: false, width: 80, height: 24, path: p },
      ];
      return id;
    },
    mux_send: () => null,
    mux_open_terminal: () => null,

    // The chat. The fake runs no agent: a test pushes narration with
    // `__fake.emit("chat-delta", ...)` / `"chat-done"` and reads what the app
    // sent out of `calls`, which is the same boundary the real backend has.
    /*
     * The ACP side. The real backend owns a long-lived agent process; this
     * owns a counter. What the two have in common is the boundary — a turn id
     * out, events in — which is all the panel can see of either.
     */
    agent_prompt: () => {
      if (state.failNextSend) {
        const why = state.failNextSend;
        state.failNextSend = null;
        throw new Error(why);
      }
      const id = nextChat++;
      state.chats[id] = true;
      return id;
    },
    agent_cancel: () => null,
    agent_permission: ({ requestId, option }) => {
      state.answered.push({ requestId: String(requestId), option: (option ?? null) as string | null });
      return null;
    },
    agent_auto_allow: () => null,
    agent_stop: () => null,
    /**
     * Setting an option returns the *mutated* list, as a real agent does —
     * so a test can tell a picker that reflects the agent's answer from one
     * that merely reflects the click.
     */
    agent_set_config: ({ id, value }) => {
      state.options = state.options.map((o: Record<string, unknown>) =>
        o.id === id ? { ...o, currentValue: value } : o,
      );
      return null;
    },


    // The event plumbing under @tauri-apps/api `listen`. transformCallback is
    // the identity above, so the handler arrives as the function itself.
    // Unlisten must really unregister, exactly as Tauri's does: React's
    // StrictMode mounts, cleans up, and mounts again, and a fake that keeps
    // the first listener delivers every event twice.
    "plugin:event|listen": ({ event, handler }) => {
      const id = nextListener++;
      (state.listeners[event] ??= []).push({ id, fn: handler });
      return id;
    },
    "plugin:event|unlisten": ({ event, eventId }) => {
      state.listeners[event] = (state.listeners[event] ?? []).filter((l) => l.id !== eventId);
      return null;
    },
    perf_log: () => null,

    // The native ask sheet. Recorded and answered from `state`, so a test can
    // assert that something irreversible asked before doing it — the browser's
    // own confirm() is not used inside the app, because a WKWebView swallows
    // it.
    "plugin:dialog|ask": ({ message }) => {
      state.asked.push(String(message ?? ""));
      return state.confirmAnswer;
    },
    "plugin:dialog|confirm": ({ message }) => {
      state.asked.push(String(message ?? ""));
      return state.confirmAnswer;
    },
    // What `ask()` actually invokes in plugin-dialog v2 — the name is
    // "message" whichever of the three helpers you called.
    // `ask()` compares the response to its own ok label, so the answer is a
    // button name rather than a boolean.
    "plugin:dialog|message": ({ message, buttons }) => {
      state.asked.push(String(message ?? ""));
      // Custom labels arrive as { OkCancelCustom: [ok, cancel] }; the plain
      // "YesNo" form arrives as the string.
      const custom = (buttons as { OkCancelCustom?: [string, string] } | string | undefined);
      const pair =
        typeof custom === "object" && custom?.OkCancelCustom
          ? custom.OkCancelCustom
          : ["Yes", "No"];
      return state.confirmAnswer ? pair[0] : pair[1];
    },

    // The CLI script: absent until installed, and this build's once it is.
    cli_status: () => state.cli,
    agent_list: () => [
      {
        id: "claude",
        label: "Claude Code",
        ready: state.chat,
        install: "Needs Node. Runs via npx on first use.",
        argv: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
      },
      {
        id: "codex",
        label: "Codex",
        ready: !!state.codex,
        install: "Needs Node and a Codex login.",
        argv: ["npx", "-y", "@agentclientprotocol/codex-acp"],
      },
    ],
    install_cli: () => {
      state.cli = { path: "/opt/homebrew/bin/plans", current: true };
      return state.cli.path;
    },
    cli_open_path: () => null,

    // The updater has to be genuinely inert here, not merely never triggered:
    // a test run that reaches out to GitHub is flaky by construction, and one
    // that starts downloading a build is worse. null is the plugin's own way
    // of saying "nothing newer", so the app takes the ordinary path.
    "plugin:updater|check": () =>
      update
        ? { available: true, currentVersion: "0.0.0-test", version: update.version, body: update.notes, rid: 1, rawJson: {} }
        : null,
    "plugin:app|version": () => "0.0.0-test",
  };

  let nextListener = 1;
  // Every other command answers plainly rather than throwing, so a test is
  // never derailed by something incidental like a push.
  const fallback = () => "";

  // The event plugin's own shim calls this before invoking unlisten; without
  // it, unlisten throws and every re-mounted listener is delivered twice.
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  (window as any).__TAURI_INTERNALS__ = {
    ...(window as any).__TAURI_INTERNALS__,
    transformCallback: (cb: unknown) => cb,
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      state.calls.push({ cmd, args });
      const handler = handlers[cmd] ?? fallback;
      return handler(args as Record<string, any>);
    },
  };

  (window as any).__fake = state;
}
