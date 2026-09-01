/**
 * One version, four places.
 *
 * Changesets only knows about package.json. Looped Plans carries the same version in
 * src-tauri/tauri.conf.json (what Tauri stamps into the bundle, and what the
 * updater compares against), src-tauri/Cargo.toml, and Cargo.lock. A bundle
 * labelled with the previous version is invisible until a user reports it.
 *
 * It also writes src/release-notes.ts — the current version's section of
 * CHANGELOG.md, bundled so the app can open its own notes offline and instantly,
 * including for someone who installed the .dmg by hand.
 *
 *   node scripts/sync-version.mjs            write the version everywhere
 *   node scripts/sync-version.mjs --check    fail if the files disagree
 *   node scripts/sync-version.mjs --notes    print this version's notes
 *
 * --notes is what release.yml passes to tauri-action as the release body, so a
 * draft release arrives with its notes already written.
 *
 * The --check mode runs in ci.yml. Automation that can be bypassed by editing
 * one file by hand is not a guarantee; the check is.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const notesOnly = process.argv.includes("--notes");

const path = (p) => resolve(ROOT, p);
const read = (p) => readFileSync(path(p), "utf8");

const version = JSON.parse(read("package.json")).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json has no usable version: ${version}`);
  process.exit(1);
}

/**
 * The current version's section of CHANGELOG.md, without its heading. Empty
 * before the first `changeset version`, which every caller has to survive.
 */
function notes() {
  let log;
  try {
    log = read("CHANGELOG.md");
  } catch {
    return "";
  }
  // Changesets writes "## 0.1.0" per release; take everything up to the next
  // release heading.
  const head = `\n## ${version}\n`;
  const at = log.indexOf(head);
  if (at === -1) return "";
  const rest = log.slice(at + head.length);
  const end = rest.search(/\n## \d/);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Every released section of CHANGELOG.md, newest first.
 *
 * The app shows what changed *since the version you last saw*, which is not
 * the same as the current version's section: skip two releases and the notes
 * for both are news to you. Bundling all of them costs a few kilobytes and
 * removes any need to fetch anything to answer the question.
 */
function allNotes() {
  let log;
  try {
    log = read("CHANGELOG.md");
  } catch {
    return [];
  }
  const out = [];
  const re = /^## (\d[^\n]*)$/gm;
  const heads = [...log.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index + heads[i][0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : log.length;
    out.push({ version: heads[i][1].trim(), notes: log.slice(from, to).trim() });
  }
  return out;
}

if (notesOnly) {
  process.stdout.write(notes());
  process.exit(0);
}

/** Files that disagreed, for the --check report. */
const wrong = [];
/** Files that were rewritten, for the normal run's report. */
const changed = [];

/**
 * Apply `edit` to a file, then either write it or record the disagreement.
 * `found` is what the file currently claims, for the error message.
 */
function reconcile(rel, current, next) {
  const before = read(rel);
  if (current === version) return;
  if (check) {
    wrong.push(`${rel} says ${current ?? "nothing"}, package.json says ${version}`);
    return;
  }
  const after = next();
  if (after !== before) {
    writeFileSync(path(rel), after);
    changed.push(rel);
  }
}

// --- tauri.conf.json --------------------------------------------------------
// Edited as text rather than JSON.parse/stringify: the file is hand-maintained
// and reformatting the whole thing to change one field is a diff nobody asked
// for.
{
  const rel = "src-tauri/tauri.conf.json";
  const text = read(rel);
  const found = text.match(/^(\s*)"version":\s*"([^"]*)"/m);
  reconcile(rel, found?.[2], () =>
    text.replace(/^(\s*)"version":\s*"[^"]*"/m, `$1"version": "${version}"`),
  );
}

// --- Cargo.toml -------------------------------------------------------------
// Only the [package] version, which is the first `version = ` in the file —
// the dependency versions further down are not ours to touch.
{
  const rel = "src-tauri/Cargo.toml";
  const text = read(rel);
  const found = text.match(/^version\s*=\s*"([^"]*)"/m);
  reconcile(rel, found?.[1], () =>
    text.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`),
  );
}

// --- Cargo.lock -------------------------------------------------------------
// Left to cargo, which is the only thing that can update it correctly. A lock
// file that still names the old version fails `cargo build --locked` in CI.
{
  const rel = "src-tauri/Cargo.lock";
  let found;
  try {
    const text = read(rel);
    found = text.match(/name = "plans"\nversion = "([^"]*)"/)?.[1];
  } catch {
    found = version; // No lock file yet; nothing to reconcile.
  }
  if (found !== version) {
    if (check) {
      wrong.push(`${rel} says ${found ?? "nothing"}, package.json says ${version}`);
    } else {
      try {
        execFileSync("cargo", ["update", "-p", "plans"], {
          cwd: path("src-tauri"),
          stdio: "inherit",
        });
        changed.push(rel);
      } catch {
        // Cargo missing on a frontend-only machine is not a reason to fail the
        // version bump; CI's --check catches a lock file left behind.
        console.warn("could not run `cargo update -p plans` — update Cargo.lock by hand");
      }
    }
  }
}

// --- src/release-notes.ts ---------------------------------------------------
// The current version's section of CHANGELOG.md, as a module the frontend
// imports. Committed rather than gitignored, so `tsc --noEmit` in ci.yml does
// not need a build to have run first.
{
  const rel = "src/release-notes.ts";
  const body = notes();

  const sections = allNotes();

  const next =
    `// Generated by scripts/sync-version.mjs from CHANGELOG.md. Do not edit.\n` +
    `export const RELEASE_VERSION = ${JSON.stringify(version)};\n` +
    `export const RELEASE_NOTES = ${JSON.stringify(body)};\n` +
    `\n/** Every released section, newest first — for "what changed since I last looked". */\n` +
    `export const RELEASE_SECTIONS: { version: string; notes: string }[] = [\n` +
    sections
      .map(
        (s) =>
          `  { version: ${JSON.stringify(s.version)}, notes: ${JSON.stringify(s.notes)} },\n`,
      )
      .join("") +
    `];\n`;

  let before = "";
  try {
    before = read(rel);
  } catch {
    /* first run */
  }
  if (before !== next) {
    if (check) wrong.push(`${rel} is stale — run \`node scripts/sync-version.mjs\``);
    else {
      writeFileSync(path(rel), next);
      changed.push(rel);
    }
  }
}

// --- report -----------------------------------------------------------------
if (check) {
  if (wrong.length) {
    console.error(`Version drift (package.json is ${version}):`);
    for (const w of wrong) console.error(`  ${w}`);
    console.error("\nRun `node scripts/sync-version.mjs` and commit the result.");
    process.exit(1);
  }
  console.log(`Version ${version} is consistent everywhere.`);
} else {
  console.log(
    changed.length
      ? `Version ${version} written to ${changed.join(", ")}.`
      : `Version ${version} was already everywhere.`,
  );
}
