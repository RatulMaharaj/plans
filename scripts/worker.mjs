#!/usr/bin/env node
/**
 * The worker: a dispatcher, not an orchestrator.
 *
 * Loops over the repos in its config: fetch, scan the default branch's plans
 * folder, pick one unit of work, and spawn `claude -p` on it headless. Two
 * kinds of run, matching the board's handoffs (skills/plans/SKILL.md):
 *
 *   draft  -> a flesh-out run: the plans skill turns the seed into a ready
 *             plan and pushes it to the default branch (plans-only push).
 *   ready  -> an implementation run: the pr skill claims it with a pushed
 *             busy flip, builds in a worktree, and opens a PR.
 *
 * The invocation copies claude-code-action's stance, not a permission bypass:
 * acceptEdits + a scoped allowlist, pushes only through git-push.sh, and
 * --max-turns plus a wall-clock timeout bounding every run. See
 * plans/claude-code-action-findings.md for why each choice is what it is.
 *
 * Config is the worker's own file (default ~/.plans-worker.json), never the
 * app's settings — the worker must run on machines the app is not installed
 * on. Run with no config to get a commented example. Flags:
 *
 *   --config <path>   config file (default ~/.plans-worker.json)
 *   --once            one scan-and-dispatch cycle, then exit
 *   --dry-run         scan and report what would run, spawn nothing
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, createWriteStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CONFIG_PATH = opt("--config", join(homedir(), ".plans-worker.json"));
const WORKDIR = join(homedir(), ".plans-worker");
const REPOS_DIR = join(WORKDIR, "repos");
const LOGS_DIR = join(WORKDIR, "logs");
const BIN_DIR = join(WORKDIR, "bin");

const EXAMPLE_CONFIG = `{
  "repos": ["https://github.com/you/your-repo.git"],
  "model": "opus",
  "effort": "medium",
  "pollSeconds": 60,
  "maxTurns": 80,
  "timeoutMinutes": 45,
  "allowedTools": []
}
`;

if (!existsSync(CONFIG_PATH)) {
  console.error(`No config at ${CONFIG_PATH}. Example:\n\n${EXAMPLE_CONFIG}`);
  console.error(`repos entries may also be objects: { "url": "...", "allowedTools": ["Bash(pnpm test:*)"] }`);
  console.error(`allowedTools is for the repo's verify commands; everything else is already granted.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const DEFAULTS = {
  model: config.model ?? "opus",
  effort: config.effort ?? "medium",
  pollSeconds: config.pollSeconds ?? 60,
  maxTurns: config.maxTurns ?? 250,
  timeoutMinutes: config.timeoutMinutes ?? 45,
};
const repos = (config.repos ?? []).map((r) => (typeof r === "string" ? { url: r } : r));
if (repos.length === 0) {
  console.error("Config lists no repos.");
  process.exit(1);
}

for (const d of [WORKDIR, REPOS_DIR, LOGS_DIR, BIN_DIR]) mkdirSync(d, { recursive: true });

// The push wrapper travels with the worker so it exists for every repo,
// at one absolute path usable from clone and worktree alike.
const PUSH_WRAPPER = join(BIN_DIR, "git-push.sh");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "git-push.sh"), PUSH_WRAPPER);
chmodSync(PUSH_WRAPPER, 0o755);

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function ensureClone(repo) {
  const name = basename(repo.url, ".git").replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(REPOS_DIR, name);
  if (!existsSync(dir)) {
    console.log(`[${name}] cloning ${repo.url}`);
    execFileSync("git", ["clone", repo.url, dir], { encoding: "utf8" });
  }
  git(dir, "fetch", "origin", "--prune");
  git(dir, "remote", "set-head", "origin", "--auto");
  const def = git(dir, "symbolic-ref", "refs/remotes/origin/HEAD").replace("refs/remotes/origin/", "");
  if (git(dir, "status", "--porcelain") !== "") {
    throw new Error(`clone is dirty (a previous run left changes) — inspect ${dir}`);
  }
  git(dir, "checkout", "-B", def, `origin/${def}`);
  return { name, dir, def };
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+?)\s*$/);
      if (kv) fm[kv[1].toLowerCase()] = kv[2].toLowerCase();
    }
  }
  return fm;
}

function scanPlans(dir) {
  const root = join(dir, "plans");
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (d, rel) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const r = rel ? `${rel}/${entry}` : entry;
      if (statSync(p).isDirectory()) {
        if (!["complete", "completed"].includes(entry)) walk(p, r);
      } else if (entry.endsWith(".md")) {
        out.push({ rel: `plans/${r}`, folder: rel ? rel.split("/")[0] : null, ...frontmatter(readFileSync(p, "utf8")) });
      }
    }
  };
  walk(root, "");
  return out;
}

const MODEL_RANK = ["haiku", "sonnet", "opus"];
const EFFORT_RANK = ["low", "medium", "high", "xhigh", "max"];
const highest = (rank, values, fallback) => {
  const present = values.filter((v) => rank.includes(v));
  return present.length ? rank[Math.max(...present.map((v) => rank.indexOf(v)))] : fallback;
};

// One unit per cycle per repo: drafts first (they unblock the rest of the
// flow and are cheap), then one ready unit — a lone ready plan or a feature
// folder with a ready plan and no busy ones (busy means another run owns it).
function pickUnit(plans) {
  const draft = plans.find((p) => p.status === "draft");
  if (draft) return { kind: "flesh", files: [draft.rel], model: draft.model, effort: draft.effort };

  const folders = new Map();
  for (const p of plans.filter((p) => p.folder && p.folder !== "drafts")) {
    if (!folders.has(p.folder)) folders.set(p.folder, []);
    folders.get(p.folder).push(p);
  }
  for (const [, members] of folders) {
    if (members.some((p) => p.status === "ready") && !members.some((p) => p.status === "busy")) {
      return {
        kind: "implement",
        files: members.map((p) => p.rel),
        model: highest(MODEL_RANK, members.map((p) => p.model), undefined),
        effort: highest(EFFORT_RANK, members.map((p) => p.effort), undefined),
      };
    }
  }
  const ready = plans.find((p) => !p.folder && p.status === "ready");
  if (ready) return { kind: "implement", files: [ready.rel], model: ready.model, effort: ready.effort };
  return null;
}

function skillPath(dir, name) {
  for (const p of [`skills/${name}/SKILL.md`, `.claude/skills/${name}/SKILL.md`]) {
    if (existsSync(join(dir, p))) return p;
  }
  return null;
}

function buildPrompt(unit, repo) {
  const common = `You are a headless dispatched run: nobody is watching and nothing can answer a question, so never ask one. The ONLY way you may push is: ${PUSH_WRAPPER} origin <branch> — plain git push will be denied.`;
  if (unit.kind === "flesh") {
    const skill = skillPath(repo.dir, "plans") ?? "(no plans skill found — follow the frontmatter conventions in existing plans)";
    return `${common}
Read ${skill} and follow its conventions. Flesh out the draft plan at ${unit.files[0]} into a plan a session could build from: approach, the files involved, what is out of scope — keeping the human's intent and words where they survive. Fleshing out is writing, not building; do not implement anything. When it would hold up to being implemented, set its status to ready. Commit only that file, then push the default branch (${repo.def}) with the wrapper above.`;
  }
  const skill = skillPath(repo.dir, "pr") ?? "(no pr skill found — claim with a pushed busy flip, build in a worktree, open a PR, never merge)";
  return `${common}
Read ${skill} and follow it exactly. Your unit of work has already been picked for you: ${unit.files.join(", ")}. You are in the worker's own checkout of the default branch (${repo.def}) at the origin tip; the skill's worktree, claim, and PR rules all apply from here.`;
}

const BASE_ALLOWED = [
  "Glob", "Grep", "LS", "Read",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git branch:*)",
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git rm:*)",
  "Bash(git worktree:*)", "Bash(git fetch:*)", "Bash(git checkout:*)",
  `Bash(${PUSH_WRAPPER}:*)`,
  "Bash(gh pr create:*)", "Bash(gh pr list:*)",
];

function runAgent(unit, repo) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = basename(unit.files[0], ".md");
  const logPath = join(LOGS_DIR, `${stamp}-${repo.name}-${unit.kind}-${slug}.log`);
  // An invalid hint degrades to the default rather than reaching `claude -p`
  // and failing the run over a typo. Warn so the typo gets fixed.
  const routed = (rank, value, fallback) => {
    if (value && !rank.includes(value)) {
      console.warn(`[${repo.name}] ignoring invalid frontmatter hint '${value}' (valid: ${rank.join(", ")})`);
      return fallback;
    }
    return value ?? fallback;
  };
  const model = routed(MODEL_RANK, unit.model, DEFAULTS.model);
  const effort = routed(EFFORT_RANK, unit.effort, DEFAULTS.effort);
  const allowed = [...BASE_ALLOWED, ...(config.allowedTools ?? []), ...(repo.allowedTools ?? [])];
  const argv = [
    "-p", buildPrompt(unit, repo),
    "--model", model, "--effort", effort,
    "--permission-mode", "acceptEdits",
    "--allowedTools", allowed.join(","),
    "--disallowedTools", "WebSearch,WebFetch",
    "--max-turns", String(DEFAULTS.maxTurns),
  ];
  console.log(`[${repo.name}] ${unit.kind} ${unit.files.join(", ")} (model=${model} effort=${effort}) -> ${logPath}`);
  return new Promise((resolve) => {
    const log = createWriteStream(logPath);
    log.write(`# ${unit.kind} ${unit.files.join(", ")}\n# model=${model} effort=${effort} started=${new Date().toISOString()}\n\n`);
    const child = spawn("claude", argv, { cwd: repo.dir, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => {
      log.write(`\n# TIMEOUT after ${DEFAULTS.timeoutMinutes}m — killed\n`);
      child.kill("SIGKILL");
    }, DEFAULTS.timeoutMinutes * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end(`\n# exited ${code} at ${new Date().toISOString()}\n`);
      resolve(code);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log.end(`\n# spawn failed: ${err.message}\n`);
      resolve(-1);
    });
  });
}

// Exit status alone lies (claude-code-action treats it skeptically; so do
// we): after a run, re-fetch and read the unit's status off the origin tip.
function verify(unit, repo, code) {
  git(repo.dir, "fetch", "origin");
  const statuses = unit.files.map((f) => {
    try {
      return frontmatter(git(repo.dir, "show", `origin/${repo.def}:${f}`)).status ?? "?";
    } catch {
      return "missing";
    }
  });
  const summary = unit.files.map((f, i) => `${f}=${statuses[i]}`).join(" ");
  if (code !== 0) {
    console.log(`[${repo.name}] run FAILED (exit ${code}); board says: ${summary}`);
  } else if (unit.kind === "flesh") {
    console.log(`[${repo.name}] flesh-out done; board says: ${summary}${statuses[0] === "ready" ? "" : " (expected ready — check the log)"}`);
  } else if (statuses.every((s) => s === "busy")) {
    console.log(`[${repo.name}] implement run finished with the claim still busy on ${repo.def} — a PR should exist (its done flip travels in the branch); if none does, this is a stale claim: flip it back to ready.`);
  } else {
    console.log(`[${repo.name}] implement run done; board says: ${summary}`);
  }
}

async function cycle() {
  let dispatched = false;
  for (const repo of repos) {
    let r;
    try {
      r = { ...repo, ...ensureClone(repo) };
    } catch (e) {
      console.error(`[${repo.url}] skipped: ${e.message}`);
      continue;
    }
    const unit = pickUnit(scanPlans(r.dir));
    if (!unit) continue;
    dispatched = true;
    if (flag("--dry-run")) {
      console.log(`[${r.name}] would ${unit.kind}: ${unit.files.join(", ")} (model=${unit.model ?? DEFAULTS.model} effort=${unit.effort ?? DEFAULTS.effort})`);
      continue;
    }
    const code = await runAgent(unit, r);
    verify(unit, r, code);
  }
  return dispatched;
}

const main = async () => {
  console.log(`plans-worker: ${repos.length} repo(s), defaults model=${DEFAULTS.model} effort=${DEFAULTS.effort}, poll ${DEFAULTS.pollSeconds}s, logs in ${LOGS_DIR}`);
  for (;;) {
    const did = await cycle();
    if (flag("--once") || flag("--dry-run")) break;
    if (!did) await new Promise((r) => setTimeout(r, DEFAULTS.pollSeconds * 1000));
  }
};
main();
