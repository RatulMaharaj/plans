import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { timed } from "./perf";

/** Every command goes through here, so the profiler sees the Rust boundary. */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return timed(`ipc ${cmd}`, () => rawInvoke<T>(cmd, args));
}

export type RepoInfo = {
  path: string;
  name: string;
  branch: string;
  planDirs: string[];
};

export type PlanFile = {
  relPath: string;
  name: string;
  dir: string;
  modified: number;
  /** The `status:` value from the file's frontmatter, if it has one. */
  status: string | null;
};

export type StatusEntry = {
  path: string;
  index: string;
  worktree: string;
};

export type GitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  entries: StatusEntry[];
};

export type BranchList = { current: string; branches: string[] };

/** Rust serialises snake_case; convert the few fields we care about. */
function camelRepo(r: any): RepoInfo {
  return { path: r.path, name: r.name, branch: r.branch, planDirs: r.plan_dirs };
}
function camelFile(f: any): PlanFile {
  return {
    relPath: f.rel_path,
    name: f.name,
    dir: f.dir,
    modified: f.modified,
    status: f.status ?? null,
  };
}
function camelStatus(s: any): GitStatus {
  return {
    branch: s.branch,
    ahead: s.ahead,
    behind: s.behind,
    hasUpstream: s.has_upstream,
    entries: s.entries,
  };
}

export const api = {
  openRepo: (path: string) => invoke<any>("open_repo", { path }).then(camelRepo),

  listPlans: (repo: string, dirs: string[], includeIgnored = false) =>
    invoke<any[]>("list_plans", { repo, dirs, includeIgnored }).then((xs) =>
      xs.map(camelFile),
    ),

  /** The text plus a fingerprint of the version it came from. */
  readPlan: (repo: string, relPath: string) =>
    invoke<{ content: string; stamp: string }>("read_plan", { repo, relPath }),

  /** Write an image beside a document; returns the path to link to. */
  writeAsset: (
    repo: string,
    relPath: string,
    folder: string,
    stem: string,
    ext: string,
    bytes: number[],
  ) => invoke<string>("write_asset", { repo, relPath, folder, stem, ext, bytes }),

  /** Lines inside the repository's markdown that contain `query`. */
  searchPlans: (repo: string, query: string, includeIgnored = false, limit = 60) =>
    invoke<{ relPath: string; line: number; text: string }[]>("search_plans", {
      repo,
      query,
      includeIgnored,
      limit,
    }).then((hits) =>
      hits.map((h: any) => ({ relPath: h.rel_path, line: h.line, text: h.text })),
    ),

  /** Development only: profiler output, to a file anyone can read. */
  perfLog: (line: string) => rawInvoke<void>("perf_log", { line }),

  /** An image from the repository, inlined as a data URL. */
  readAsset: (repo: string, relPath: string) =>
    invoke<string>("read_asset", { repo, relPath }),

  /** The current fingerprint, without reading the file back. */
  statPlan: (repo: string, relPath: string) =>
    invoke<string>("stat_plan", { repo, relPath }),

  /**
   * Write, refusing if the file no longer matches `expectStamp`. Returns the
   * new fingerprint. Rejects with "STALE" when something else got there first.
   */
  writePlan: (repo: string, relPath: string, content: string, expectStamp?: string) =>
    invoke<string>("write_plan", { repo, relPath, content, expectStamp }),

  createPlan: (repo: string, relPath: string, title: string) =>
    invoke<void>("create_plan", { repo, relPath, title }),

  createFolder: (repo: string, relPath: string) =>
    invoke<void>("create_folder", { repo, relPath }),

  renamePlan: (repo: string, from: string, to: string) =>
    invoke<void>("rename_plan", { repo, from, to }),

  deletePlan: (repo: string, relPath: string) =>
    invoke<void>("delete_plan", { repo, relPath }),

  /** How many files a folder holds, and how many of them the tree hides. */
  folderCensus: (repo: string, relPath: string) =>
    invoke<{ files: number; hidden: number }>("folder_census", { repo, relPath }),

  deleteFolder: (repo: string, relPath: string) =>
    invoke<void>("delete_folder", { repo, relPath }),

  /** Which of these folders still exist on disk. */
  existingDirs: (repo: string, relPaths: string[]) =>
    invoke<string[]>("existing_dirs", { repo, relPaths }),

  /** Show the file or folder in Finder (or the platform's file manager). */
  revealInFinder: (repo: string, relPath: string) =>
    invoke<void>("reveal_in_finder", { repo, relPath }),

  gitStatus: (repo: string, scope: string[]) =>
    invoke<any>("git_status", { repo, scope }).then(camelStatus),

  gitDiff: (repo: string, relPath: string, staged: boolean) =>
    invoke<string>("git_diff", { repo, relPath, staged }),

  gitHeadText: (repo: string, relPath: string) =>
    invoke<string>("git_head_text", { repo, relPath }),

  gitStage: (repo: string, paths: string[]) =>
    invoke<void>("git_stage", { repo, paths }),

  gitUnstage: (repo: string, paths: string[]) =>
    invoke<void>("git_unstage", { repo, paths }),

  gitDiscard: (repo: string, paths: string[]) =>
    invoke<void>("git_discard", { repo, paths }),

  gitCommit: (repo: string, message: string) =>
    invoke<string>("git_commit", { repo, message }),

  gitPush: (repo: string) => invoke<string>("git_push", { repo }),

  gitPull: (repo: string) => invoke<string>("git_pull", { repo }),

  gitBranches: (repo: string) => invoke<BranchList>("git_branches", { repo }),

  gitCreateBranch: (repo: string, name: string) =>
    invoke<string>("git_create_branch", { repo, name }),

  gitFetch: (repo: string) => invoke<string>("git_fetch", { repo }),

  /** Who git says the user is — name and email may be empty when unset. */
  gitIdentity: (repo: string) =>
    invoke<{ name: string; email: string }>("git_identity", { repo }),

  gitCheckout: (repo: string, branch: string) =>
    invoke<string>("git_checkout", { repo, branch }),

  gitLog: (repo: string, scope: string[], limit: number) =>
    invoke<string>("git_log", { repo, scope, limit }).then((raw) =>
      raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, date, author, subject] = line.split("\u001F");
          return { hash, date, author, subject };
        }),
    ),
};
