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
  };

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
        entries: (r?.modified ?? []).map((path) => ({ path, index: " ", worktree: "M" })),
      };
    },
    git_branches: ({ repo: p }) => ({
      current: repo(p)?.branch ?? "main",
      branches: [repo(p)?.branch ?? "main", "other"],
    }),
    read_asset: () => "data:image/png;base64,iVBORw0KGgo=",
    perf_log: () => null,

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

  // Every other command answers plainly rather than throwing, so a test is
  // never derailed by something incidental like a push.
  const fallback = () => "";

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
