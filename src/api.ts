import { invoke } from "@tauri-apps/api/core";

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
  return { relPath: f.rel_path, name: f.name, dir: f.dir, modified: f.modified };
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

  listPlans: (repo: string, dirs: string[]) =>
    invoke<any[]>("list_plans", { repo, dirs }).then((xs) => xs.map(camelFile)),

  readPlan: (repo: string, relPath: string) =>
    invoke<string>("read_plan", { repo, relPath }),

  writePlan: (repo: string, relPath: string, content: string) =>
    invoke<void>("write_plan", { repo, relPath, content }),

  createPlan: (repo: string, relPath: string, title: string) =>
    invoke<void>("create_plan", { repo, relPath, title }),

  renamePlan: (repo: string, from: string, to: string) =>
    invoke<void>("rename_plan", { repo, from, to }),

  deletePlan: (repo: string, relPath: string) =>
    invoke<void>("delete_plan", { repo, relPath }),

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
