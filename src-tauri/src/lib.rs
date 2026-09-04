use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub mod agent;
pub mod mux;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type R<T> = Result<T, String>;

/// Resolve `rel` against `repo`, refusing anything that escapes the repo root.
fn safe_join(repo: &str, rel: &str) -> R<PathBuf> {
    let root = PathBuf::from(repo);
    let rel = Path::new(rel);
    if rel.is_absolute() {
        return Err("absolute paths are not allowed".into());
    }
    for c in rel.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("path escapes the repository".into()),
        }
    }
    Ok(root.join(rel))
}

/// Run a binary with an explicit argv and return its stdout.
///
/// No shell, ever: the argv is passed through as given, so nothing in a path or
/// a prompt can turn into a second command. Failure carries the process's own
/// stderr, because that is always more useful than anything we would invent.
pub(crate) fn exec(bin: &str, args: &[&str]) -> R<String> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    no_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run {bin}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{bin} {} failed", args.join(" "))
        } else {
            err
        })
    }
}

/// Keep a child process from opening a console window of its own.
///
/// On Windows a GUI-subsystem app that spawns a console-subsystem child —
/// git.exe, cmd.exe, npm.cmd — gets a console window popped for each one.
/// The app polls git every few seconds, so without this flag it strobes.
/// One function, applied at the few places that build a `Command`, rather
/// than a `#[cfg]` at each; elsewhere it does nothing.
pub(crate) fn no_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// `CREATE_NO_WINDOW` and `CREATE_NEW_CONSOLE` from `processthreadsapi.h`.
/// Two constants are not worth a crate.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

fn git(repo: &str, args: &[&str]) -> R<String> {
    let mut argv = vec!["-C", repo];
    argv.extend_from_slice(args);
    exec("git", &argv)
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
];

fn looks_like_plans_dir(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "plans" || n == "plan" || n.ends_with("-plans") || n.ends_with("_plans")
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct RepoInfo {
    path: String,
    name: String,
    branch: String,
    plan_dirs: Vec<String>,
}

#[derive(Serialize)]
pub struct PlanFile {
    rel_path: String,
    name: String,
    dir: String,
    modified: u64,
    /// The `status:` value from the file's frontmatter, if it has one.
    status: Option<String>,
}

#[derive(Serialize)]
pub struct StatusEntry {
    path: String,
    /// index (staged) status code, ' ' when clean
    index: String,
    /// worktree (unstaged) status code, ' ' when clean
    worktree: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    ahead: u32,
    behind: u32,
    has_upstream: bool,
    entries: Vec<StatusEntry>,
    /// "merge", "rebase", "cherry-pick" or "revert" while one is unfinished.
    ///
    /// The app cannot finish any of them, but it must stop pretending the
    /// repository is in an ordinary state — offering push mid-merge is how a
    /// person ends up with a half-merged branch on the remote.
    operation: Option<String>,
}

/// Where the `plans` script is, and whether it matches the running build.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    path: String,
    current: bool,
    /// Whether the folder the script sits in is on this process's PATH. On
    /// Linux the script goes to `~/.local/bin`, which most shells put on PATH
    /// and some do not, and "installed but unreachable" deserves its own word.
    #[serde(rename = "onPath")]
    on_path: bool,
}

#[derive(Serialize, Deserialize)]
pub struct BranchList {
    current: String,
    branches: Vec<String>,
    /// Branches that exist only on a remote, full `origin/name` form, deduped
    /// against the local list. Checking one out creates the tracking branch.
    remotes: Vec<String>,
}

// ---------------------------------------------------------------------------
// repo / file commands
// ---------------------------------------------------------------------------

fn walk_for_plan_dirs(dir: &Path, root: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let p = e.path();
        if looks_like_plans_dir(&name) {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            // don't descend into a plans dir looking for more plans dirs
            continue;
        }
        walk_for_plan_dirs(&p, root, depth + 1, out);
    }
}

#[tauri::command]
fn open_repo(path: String) -> R<RepoInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    // Resolve to the repository top level so nested selections still work.
    let top = git(&path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("{path} is not inside a git repository"))?
        .trim()
        .to_string();
    let root = PathBuf::from(&top);

    let branch = git(&top, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut plan_dirs = Vec::new();
    walk_for_plan_dirs(&root, &root, 0, &mut plan_dirs);
    plan_dirs.sort();

    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());

    Ok(RepoInfo {
        path: top,
        name,
        branch,
        plan_dirs,
    })
}

/// The `status:` line from a file's YAML frontmatter, read from the head of
/// the file only — the block must open the file, so 2KB is plenty.
///
/// The poll lists every markdown file every few seconds, and opening each one
/// to look for a status would turn a directory walk into a full read of the
/// repository. The cache makes the steady state free: a file is only re-read
/// when its mtime moves.
fn frontmatter_status(path: &Path, modified: u64) -> Option<String> {
    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::{Mutex, OnceLock};

    /// Path to the mtime it was read at, and what it said.
    type Cache = HashMap<PathBuf, (u64, Option<String>)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Ok(map) = cache.lock() {
        if let Some((at, status)) = map.get(path) {
            if *at == modified {
                return status.clone();
            }
        }
    }

    let status = (|| {
        let mut head = [0u8; 2048];
        let mut f = std::fs::File::open(path).ok()?;
        let n = f.read(&mut head).ok()?;
        let text = String::from_utf8_lossy(&head[..n]);
        let mut lines = text.lines();
        if lines.next()?.trim_end() != "---" {
            return None;
        }
        for line in lines {
            if line.trim_end() == "---" {
                return None;
            }
            // A line without a colon (a list item, say) is skipped, not fatal.
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            // Top-level keys only — an indented `status:` belongs to something else.
            if !key.starts_with(char::is_whitespace) && key.trim().eq_ignore_ascii_case("status") {
                let v = value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                return (!v.is_empty()).then_some(v);
            }
        }
        None
    })();

    if let Ok(mut map) = cache.lock() {
        map.insert(path.to_path_buf(), (modified, status.clone()));
    }
    status
}

/// Walking a repository for files — markdown only, or everything.
///
/// This was a hand-rolled recursive read_dir followed by one
/// `git check-ignore --stdin` over every path found. On a repository with a few
/// thousand markdown files that is a full single-threaded tree walk plus a
/// subprocess, on every poll — which is what made the app crawl.
///
/// `ignore` is ripgrep's walker: parallel across cores, and it reads .gitignore
/// itself, so the subprocess disappears entirely.
fn walk_files(root: &Path, include_ignored: bool, only_markdown: bool) -> Vec<PlanFile> {
    use ignore::{WalkBuilder, WalkState};
    use std::sync::Mutex;

    let found: Mutex<Vec<PlanFile>> = Mutex::new(Vec::new());
    let mut builder = WalkBuilder::new(root);
    builder
        // Two threads, not every core. This runs on a timer, in the background,
        // while someone is typing — it must never be the reason a frame is late.
        .threads(2)
        .hidden(false)
        .parents(true)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        .follow_links(false)
        // Build directories are skipped whether or not anything ignores them.
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !SKIP_DIRS.contains(&name.as_ref())
        });

    builder.build_parallel().run(|| {
        Box::new(|result| {
            let Ok(entry) = result else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .map(|s| s.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let is_markdown = ext == "md" || ext == "markdown";
            if only_markdown && !is_markdown {
                return WalkState::Continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                return WalkState::Continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let dir = rel
                .rsplit_once('/')
                .map(|(d, _)| d.to_string())
                .unwrap_or_default();
            // `status:` is a markdown-plan convention; a YAML file that
            // happens to open with `---` is not declaring one.
            let status = if is_markdown {
                frontmatter_status(path, modified)
            } else {
                None
            };
            if let Ok(mut out) = found.lock() {
                out.push(PlanFile {
                    rel_path: rel,
                    name,
                    dir,
                    modified,
                    status,
                });
            }
            WalkState::Continue
        })
    });

    found.into_inner().unwrap_or_default()
}

/// Every directory under the root, on the same walk and skip rules as the
/// files. The file walk cannot see a folder with nothing in it, so "show all
/// files" mode asks for the folders separately.
fn walk_dirs(root: &Path, include_ignored: bool) -> Vec<String> {
    use ignore::{WalkBuilder, WalkState};
    use std::sync::Mutex;

    let found: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut builder = WalkBuilder::new(root);
    builder
        .threads(2)
        .hidden(false)
        .parents(true)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        .follow_links(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !SKIP_DIRS.contains(&name.as_ref())
        });

    builder.build_parallel().run(|| {
        Box::new(|result| {
            let Ok(entry) = result else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_dir()) {
                return WalkState::Continue;
            }
            let Ok(rel) = entry.path().strip_prefix(root) else {
                return WalkState::Continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.is_empty() {
                return WalkState::Continue;
            }
            if let Ok(mut out) = found.lock() {
                out.push(rel);
            }
            WalkState::Continue
        })
    });

    let mut out = found.into_inner().unwrap_or_default();
    out.sort();
    out
}

#[tauri::command]
async fn list_dirs(repo: String, include_ignored: bool) -> R<Vec<String>> {
    Ok(walk_dirs(&PathBuf::from(&repo), include_ignored))
}

#[tauri::command]
async fn list_plans(
    repo: String,
    dirs: Vec<String>,
    include_ignored: bool,
    only_markdown: bool,
) -> R<Vec<PlanFile>> {
    let root = PathBuf::from(&repo);
    let mut out = Vec::new();
    // An empty entry means the repository itself, which is the only caller now.
    if dirs.is_empty() || dirs.iter().any(|d| d.is_empty()) {
        out = walk_files(&root, include_ignored, only_markdown);
    } else {
        for d in dirs {
            let abs = safe_join(&repo, &d)?;
            if abs.is_dir() {
                out.extend(walk_files(&abs, include_ignored, only_markdown));
            }
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// A cheap fingerprint of what is on disk, used to notice that something else
/// wrote the file while we had it open. Content-hashed rather than mtime-based:
/// two writes inside the same clock tick are common when an agent is working,
/// and reverting a file to its previous text should read as no change at all.
fn stamp_of(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// The marker returned for a file that does not exist. Distinct from any hash.
const ABSENT: &str = "absent";

fn stamp_at(p: &Path) -> String {
    match std::fs::read(p) {
        Ok(b) => stamp_of(&b),
        Err(_) => ABSENT.to_string(),
    }
}

#[derive(Serialize, Deserialize)]
pub struct PlanText {
    content: String,
    /// Pass back to `write_plan` to make the write conditional on this version.
    stamp: String,
}

#[tauri::command]
fn read_plan(repo: String, rel_path: String) -> R<PlanText> {
    let p = safe_join(&repo, &rel_path)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("could not read {rel_path}: {e}"))?;
    let content =
        String::from_utf8(bytes.clone()).map_err(|_| format!("{rel_path} is not text"))?;
    Ok(PlanText {
        stamp: stamp_of(&bytes),
        content,
    })
}

/// An image (or any small asset) from the repository, as a data URL.
///
/// The asset protocol is the usual route for this, but it depends on scope
/// configuration and a custom scheme that the dev webview would not load. The
/// files are already ours to read, so this returns the bytes directly and
/// removes the protocol from the picture entirely.
#[tauri::command]
fn read_asset(repo: String, rel_path: String) -> R<String> {
    use base64::Engine;
    let p = safe_join(&repo, &rel_path)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("could not read {rel_path}: {e}"))?;
    // Cap it: a data URL for something enormous would only stall the webview.
    if bytes.len() > 12 * 1024 * 1024 {
        return Err(format!("{rel_path} is too large to inline"));
    }
    let mime = match p
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[derive(Serialize)]
pub struct Hit {
    rel_path: String,
    /// 1-based, so it reads the way an editor counts.
    line: u32,
    /// The line itself, trimmed and clipped: enough to recognise, not to read.
    text: String,
}

/// Write an image into the repository and return its path, relative to the
/// file that will link to it.
///
/// Pasted screenshots have nowhere to live otherwise, and a data URL in a
/// markdown file is unreadable in every other tool. The name is taken from the
/// document so the folder stays legible, and collisions are numbered rather
/// than overwritten — a pasted image should never replace an earlier one.
#[tauri::command]
fn write_asset(
    repo: String,
    rel_path: String,
    folder: String,
    stem: String,
    ext: String,
    bytes: Vec<u8>,
) -> R<String> {
    // A folder under the repository root, not beside the document: images are
    // shared between notes more often than they belong to one, and a tree full
    // of assets/ folders is worse than a single place to look.
    let folder = folder.trim().trim_matches('/').to_string();
    let folder = if folder.is_empty() {
        "assets".to_string()
    } else {
        folder
    };

    let safe_stem: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase();
    let safe_stem = if safe_stem.is_empty() {
        "image".to_string()
    } else {
        safe_stem
    };
    let ext = ext.trim_start_matches('.').to_lowercase();
    let ext = if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        "png".to_string()
    };

    let abs_dir = safe_join(&repo, &folder)?;
    std::fs::create_dir_all(&abs_dir).map_err(|e| e.to_string())?;

    // Numbered rather than overwritten: a pasted image must never replace one
    // that is already linked from somewhere.
    let mut name = format!("{safe_stem}.{ext}");
    let mut n = 2;
    while abs_dir.join(&name).exists() {
        name = format!("{safe_stem}-{n}.{ext}");
        n += 1;
    }
    std::fs::write(abs_dir.join(&name), &bytes).map_err(|e| e.to_string())?;

    Ok(link_from(&rel_path, &format!("{folder}/{name}")))
}

/// A link from one repo-relative path to another, as markdown wants it.
///
/// A document in `notes/deep/` linking to `assets/x.png` needs `../../assets/x.png`;
/// one at the root needs `assets/x.png`. Getting this wrong is invisible in the
/// editor, which resolves paths itself, and broken everywhere else.
fn link_from(doc: &str, target: &str) -> String {
    let depth = doc.matches('/').count();
    if depth == 0 {
        return target.to_string();
    }
    format!("{}{}", "../".repeat(depth), target)
}

/// Search inside the files of a repository.
///
/// Filenames answer "which file was that", and are already searchable. This
/// answers the other question — "where did I write about X" — which for notes
/// is the one asked more often. Plain substring, case-insensitive: a regular
/// expression is a different feature, and most searches are neither.
#[tauri::command]
async fn search_plans(
    repo: String,
    query: String,
    include_ignored: bool,
    only_markdown: bool,
    limit: u32,
) -> R<Vec<Hit>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let root = PathBuf::from(&repo);
    let files = walk_files(&root, include_ignored, only_markdown);
    let cap = limit.max(1) as usize;

    let mut hits = Vec::new();
    for f in files {
        if hits.len() >= cap {
            break;
        }
        let Ok(text) = std::fs::read_to_string(root.join(&f.rel_path)) else {
            continue;
        };
        // Skip the whole file cheaply when it cannot contain the term.
        if !text.to_lowercase().contains(&needle) {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if hits.len() >= cap {
                break;
            }
            if !line.to_lowercase().contains(&needle) {
                continue;
            }
            let trimmed = line.trim();
            let text = if trimmed.chars().count() > 160 {
                trimmed.chars().take(160).collect::<String>() + "…"
            } else {
                trimmed.to_string()
            };
            hits.push(Hit {
                rel_path: f.rel_path.clone(),
                line: i as u32 + 1,
                text,
            });
        }
    }
    Ok(hits)
}

/// Append a line of profiler output to a file.
///
/// Development plumbing: the webview's console is only visible in the inspector,
/// which makes it useless for anyone reading the app from outside.
#[tauri::command]
fn perf_log(line: String) -> R<()> {
    use std::io::Write;
    let path = std::env::temp_dir().join("plans-perf.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// The current fingerprint without paying to send the contents back.
#[tauri::command]
fn stat_plan(repo: String, rel_path: String) -> R<String> {
    Ok(stamp_at(&safe_join(&repo, &rel_path)?))
}

/// Sentinel the frontend matches on to tell a conflict from a real IO failure.
const STALE: &str = "STALE";

/// Write, optionally only if the file still looks the way the caller last saw
/// it. Nothing is locked: the check happens immediately before the write, and a
/// mismatch is reported rather than resolved — the choice is the reader's.
#[tauri::command]
fn write_plan(
    repo: String,
    rel_path: String,
    content: String,
    expect_stamp: Option<String>,
) -> R<String> {
    let p = safe_join(&repo, &rel_path)?;
    if let Some(expected) = expect_stamp {
        let actual = stamp_at(&p);
        if actual != expected {
            return Err(STALE.to_string());
        }
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, &content).map_err(|e| format!("could not write {rel_path}: {e}"))?;
    Ok(stamp_of(content.as_bytes()))
}

/// Write a file that is not there yet, with exactly the bytes handed over.
///
/// This used to be `create_plan`, and it knew what a plan looked like: it built
/// `---\nstatus: …\n---\n# Title\n\n` itself, which made a plan the only file
/// the app could make and made every other shape a change to this file. The
/// shape now comes from a template the reader owns, so all that is left here is
/// the part that has to be here — refusing to overwrite, and `safe_join`.
#[tauri::command]
fn create_file(repo: String, rel_path: String, content: String) -> R<()> {
    let p = safe_join(&repo, &rel_path)?;
    if p.exists() {
        return Err(format!("{rel_path} already exists"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("could not write {rel_path}: {e}"))
}

/// Make a folder. It will be empty, and git will not record it until something
/// is written inside — which is git's business, not ours: the folder exists on
/// disk, and the app remembers it until it has files of its own.
#[tauri::command]
fn create_folder(repo: String, rel_path: String) -> R<()> {
    let p = safe_join(&repo, &rel_path)?;
    if p.exists() {
        return Err(format!("{rel_path} already exists"));
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("could not create {rel_path}: {e}"))
}

/// Do these differ only in case? On a case-insensitive filesystem — which is
/// the macOS default — such a rename looks like renaming a file onto itself.
fn case_only_rename(from: &str, to: &str) -> bool {
    from != to && from.to_lowercase() == to.to_lowercase()
}

#[tauri::command]
fn rename_plan(repo: String, from: String, to: String) -> R<()> {
    let a = safe_join(&repo, &from)?;
    let b = safe_join(&repo, &to)?;

    /*
     * Changing only the case of a name needs two moves.
     *
     * macOS is case-insensitive by default, so `plan.md` and `Plan.md` are the
     * same file: the existence check below sees the destination already there
     * and refuses, which is why renaming a file to its own name in different
     * case failed. Going via a name that cannot collide makes it work on a
     * case-insensitive filesystem, and is harmless on a case-sensitive one.
     */
    if case_only_rename(&from, &to) {
        let mut temp = b.clone();
        temp.set_file_name(format!(
            ".plans-rename-{}",
            b.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
        std::fs::rename(&a, &temp).map_err(|e| e.to_string())?;
        return std::fs::rename(&temp, &b).map_err(|e| e.to_string());
    }

    if b.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&a, &b).map_err(|e| e.to_string())
}

/**
 * Copy a file into another repository.
 *
 * Every other command in this file takes one `(repo, rel_path)` pair, because
 * every other operation happens inside one repository. This takes two, and the
 * two are joined independently: each relative path is still resolved inside the
 * root it was given, and neither root ever sees the other's path — so widening
 * to two repositories does not widen what `safe_join` will let through.
 *
 * A copy rather than a rename, and not only because the source is wanted where
 * it is. `std::fs::rename` fails with `EXDEV` across filesystems, so two
 * repositories on different volumes would break in a way that reads like a
 * permissions problem; and git has no notion of a rename between repositories
 * anyway — the destination sees an addition, which is the truth.
 *
 * Files only. A folder's contents raise their own questions about what counts
 * as inside it, and answering them is not needed to move a plan between two
 * repositories.
 */
#[tauri::command]
fn copy_plan(from_repo: String, from_rel: String, to_repo: String, to_rel: String) -> R<String> {
    let a = safe_join(&from_repo, &from_rel)?;
    let b = safe_join(&to_repo, &to_rel)?;
    if a == b {
        return Err("that is where it already is".into());
    }
    if b.exists() {
        return Err(format!("{to_rel} already exists"));
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&a, &b).map_err(|e| e.to_string())?;
    // The path it actually got, so the caller can open it without guessing.
    Ok(to_rel)
}

#[tauri::command]
fn delete_plan(repo: String, rel_path: String) -> R<()> {
    let p = safe_join(&repo, &rel_path)?;
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

/// What a folder holds, counted before deleting it. `hidden` is the files the
/// tree never shows — anything that is not markdown — since deleting those
/// without saying so would be deleting things the user has never seen.
#[derive(Serialize)]
struct FolderCensus {
    files: u32,
    hidden: u32,
}

#[tauri::command]
fn folder_census(repo: String, rel_path: String) -> R<FolderCensus> {
    fn walk(dir: &Path, c: &mut FolderCensus) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(&path, c)?;
            } else {
                c.files += 1;
                let md = path
                    .extension()
                    .map(|e| {
                        let e = e.to_ascii_lowercase();
                        e == "md" || e == "markdown"
                    })
                    .unwrap_or(false);
                if !md {
                    c.hidden += 1;
                }
            }
        }
        Ok(())
    }
    let p = safe_join(&repo, &rel_path)?;
    let mut c = FolderCensus {
        files: 0,
        hidden: 0,
    };
    walk(&p, &mut c).map_err(|e| e.to_string())?;
    Ok(c)
}

#[tauri::command]
fn delete_folder(repo: String, rel_path: String) -> R<()> {
    if rel_path.trim().is_empty() {
        return Err("refusing to delete the repository root".into());
    }
    let p = safe_join(&repo, &rel_path)?;
    std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
}

/// Which of these remembered folders still exist on disk? The frontend keeps
/// empty folders in localStorage — nothing on disk records them — so this is
/// how a reload lets go of the ones deleted outside the app.
#[tauri::command]
fn existing_dirs(repo: String, rel_paths: Vec<String>) -> R<Vec<String>> {
    let mut out = Vec::new();
    for rel in rel_paths {
        if safe_join(&repo, &rel)?.is_dir() {
            out.push(rel);
        }
    }
    Ok(out)
}

/// Keep the bundled skills' user-level copies fresh: `~/.plans/skills/`.
///
/// A home for the skills that belongs to no repository — for readers who use
/// them from the chat (or point other tools at them) rather than installing
/// a copy into every project. App-owned, so replaced outright on every
/// launch; edits belong upstream, not here.
#[tauri::command]
fn sync_user_skills(skills: Vec<(String, String)>) -> R<String> {
    let root = home_dir()?.join(".plans").join("skills");
    for (name, text) in &skills {
        // Names come from the app's own bundled table, but stay careful.
        if name.is_empty() || name.contains(['/', '\\', '.']) {
            return Err(format!("suspicious skill name: {name}"));
        }
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("SKILL.md"), text).map_err(|e| e.to_string())?;
    }
    Ok(root.display().to_string())
}

/// The user's home. `HOME` everywhere but Windows, where it is usually unset
/// and `USERPROFILE` is the one that answers.
fn home_dir() -> R<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "no home directory: neither HOME nor USERPROFILE is set".to_string())
}

/// The new-file templates: `~/.plans/templates/`, beside the skills.
fn templates_root() -> R<PathBuf> {
    Ok(home_dir()?.join(".plans").join("templates"))
}

#[derive(Serialize)]
struct TemplateFile {
    /// The filename, extension included — a template's identity.
    name: String,
    text: String,
}

#[derive(Serialize)]
struct Templates {
    /// Where they live, so the settings page can name it and open it.
    dir: String,
    files: Vec<TemplateFile>,
}

/// Seed the templates folder the first time, then read whatever is in it.
///
/// The skills next door are app-owned and rewritten on every launch; these are
/// the reader's, so the seeding is conditioned on the *folder* rather than on
/// each file. Writing back any default that had gone missing would mean a
/// template you deleted came back every launch — the one thing that makes a
/// folder feel like it is not yours.
#[tauri::command]
fn templates_sync(defaults: Vec<(String, String)>) -> R<Templates> {
    let root = templates_root()?;
    if !root.exists() {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        for (name, text) in &defaults {
            // Names come from the app's own bundled table, but stay careful.
            if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\']) {
                return Err(format!("suspicious template name: {name}"));
            }
            std::fs::write(root.join(name), text).map_err(|e| e.to_string())?;
        }
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.to_lowercase().ends_with(".md") {
            continue;
        }
        if !entry.path().is_file() {
            continue;
        }
        // A file that will not read is one template missing, not a failed
        // launch: the rest of the folder still works.
        if let Ok(text) = std::fs::read_to_string(entry.path()) {
            files.push(TemplateFile { name, text });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Templates {
        dir: root.display().to_string(),
        files,
    })
}

/// Hand the templates folder to the platform's file manager. Created first if
/// it is somehow not there, because "nothing happened" is the worst answer to
/// a press.
#[tauri::command]
fn templates_open() -> R<()> {
    let root = templates_root()?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    {
        exec("open", &[path.as_str()]).map(|_| ())
    }
    #[cfg(target_os = "linux")]
    {
        exec("xdg-open", &[path.as_str()]).map(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        // The empty string is `start`'s window title, which it otherwise takes
        // from the first quoted argument — the path.
        exec("cmd", &["/C", "start", "", path.as_str()]).map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// the settings file
// ---------------------------------------------------------------------------
//
// `settings.json` in the platform's config directory, with its generated
// schema beside it. Deliberately not routed through the commands above: those
// are repo-relative by construction, and this file belongs to the app rather
// than to any repository someone happens to have open.

const SETTINGS_NAME: &str = "settings.json";
const SCHEMA_NAME: &str = "settings.schema.json";

fn config_dir(app: &tauri::AppHandle) -> R<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Milliseconds since the epoch, or 0 for a file that is not there. 0 is the
/// honest answer for "no file" and also the one the watcher wants: it never
/// equals a real stamp, so appearing and disappearing both read as a change.
fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
struct SettingsFile {
    /// Where it is — shown in the settings page, because the answer to "where
    /// is my file" differs per platform.
    path: String,
    /// The file's text, or null when there is none yet.
    text: Option<String>,
    modified: u64,
}

#[tauri::command]
fn settings_read(app: tauri::AppHandle) -> R<SettingsFile> {
    let p = config_dir(&app)?.join(SETTINGS_NAME);
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    Ok(SettingsFile {
        path: p.display().to_string(),
        text,
        modified: mtime_ms(&p),
    })
}

/// Write the file and report its new stamp, so the caller can tell its own
/// write apart from someone else's.
///
/// Through a temporary file and a rename: the watcher polls this path every few
/// seconds, and a truncated read is a parse error the reader did not cause.
#[tauri::command]
fn settings_write(app: tauri::AppHandle, text: String) -> R<u64> {
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(SETTINGS_NAME);
    let tmp = dir.join(format!("{SETTINGS_NAME}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&p))
}

/// The stamp alone — what the poll asks for, so an unchanged file costs a
/// `stat` rather than a read of the whole file.
#[tauri::command]
fn settings_stat(app: tauri::AppHandle) -> R<u64> {
    Ok(mtime_ms(&config_dir(&app)?.join(SETTINGS_NAME)))
}

/// The schema, rewritten beside the file on every launch. App-owned: it is
/// generated from this build's own `Settings` type, and a stale copy is a
/// schema that lies.
#[tauri::command]
fn settings_write_schema(app: tauri::AppHandle, text: String) -> R<()> {
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SCHEMA_NAME), text).map_err(|e| e.to_string())
}

/// Open `settings.json` in whatever edits JSON on this machine.
///
/// The app is a markdown editor; teaching its buffers about an absolute-path
/// JSON file outside every repository's save machinery is real cost for a file
/// visited four times a year. Handing it to the system editor is the same
/// bridge `reveal_in_finder` already crosses — and if it turns out people live
/// in this file, an in-app JSON buffer is a later plan with its own argument.
#[tauri::command]
fn settings_open(app: tauri::AppHandle) -> R<()> {
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(SETTINGS_NAME);
    // A file that is not there yet cannot be opened, and "nothing happened" is
    // the worst possible answer to a press.
    if !p.exists() {
        std::fs::write(&p, "{}\n").map_err(|e| e.to_string())?;
    }
    let path = p.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    {
        exec("open", &[path.as_str()]).map(|_| ())
    }
    #[cfg(target_os = "linux")]
    {
        exec("xdg-open", &[path.as_str()]).map(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        // The empty string is `start`'s window title, which it otherwise takes
        // the path for — and then opens nothing.
        exec("cmd", &["/C", "start", "", path.as_str()]).map(|_| ())
    }
}

/// Show the file or folder in the platform's file manager, selected.
#[tauri::command]
fn reveal_in_finder(repo: String, rel_path: String) -> R<()> {
    let p = safe_join(&repo, &rel_path)?;
    tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// the workspace server's session, in the OS keychain
//
// One entry, keyed by the app's identifier: signing in replaces it, signing
// out removes it, and settings.json never sees it. `get` answers None rather
// than an error when there is nothing there, because "not signed in" is the
// ordinary first-launch state and not a fault.

const KEYCHAIN_SERVICE: &str = "com.ratulmaharaj.plans";
const KEYCHAIN_USER: &str = "workspaces";

/// The file the token falls back to when there is no keychain to hold it.
const TOKEN_FILE: &str = "token";

fn keychain_entry() -> R<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

/// Whether this error means there is no keychain to talk to, as opposed to
/// a keychain that answered "no" or "nothing".
///
/// On Linux `keyring` speaks Secret Service over D-Bus, and a desktop without
/// gnome-keyring or KWallet running (Omarchy, most window-manager setups,
/// any container) has no one on the other end. The crate reports that as
/// `NoStorageAccess` or as `PlatformFailure`, depending on whether the bus
/// itself or the service is what is missing. Every other error - a locked
/// collection, a bad attribute - is the keychain speaking, and is passed on.
fn keychain_unavailable(e: &keyring::Error) -> bool {
    matches!(
        e,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    )
}

/// Only Linux falls back to a file. macOS and Windows always have a
/// keychain, and a keychain error there is a fault worth surfacing rather
/// than a state to route around.
fn token_file_allowed() -> bool {
    cfg!(target_os = "linux")
}

/// Said once per process, the first time the file stands in for the
/// keychain, so a reader of the log knows where the token went.
fn note_token_fallback(e: &keyring::Error) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "plans: no keychain available ({e}); keeping the workspace token in a 0600 file under the config directory"
        );
    });
}

fn token_file(app: &tauri::AppHandle) -> R<PathBuf> {
    Ok(config_dir(app)?.join(TOKEN_FILE))
}

/// The file's text, or None when there is no file; the same shape the
/// keychain answers with.
fn token_file_get(p: &Path) -> R<Option<String>> {
    match std::fs::read_to_string(p) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the token so that only this user can read it. The mode goes on
/// before the token does: `OpenOptions::mode` applies at creation, so there
/// is no moment where the file exists world-readable with a secret in it.
/// A file left by an earlier write is truncated in place and keeps its mode.
fn token_file_set(p: &Path, token: &str) -> R<()> {
    use std::io::Write;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(p).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        // The mode above only applies to a file being created; one that was
        // already there keeps whatever it had, so say it again.
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    f.write_all(token.as_bytes()).map_err(|e| e.to_string())
}

fn token_file_clear(p: &Path) -> R<()> {
    match std::fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn workspace_token_get(app: tauri::AppHandle) -> R<Option<String>> {
    match keychain_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) if token_file_allowed() && keychain_unavailable(&e) => {
            note_token_fallback(&e);
            token_file_get(&token_file(&app)?)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn workspace_token_set(app: tauri::AppHandle, token: String) -> R<()> {
    match keychain_entry()?.set_password(&token) {
        Ok(()) => Ok(()),
        Err(e) if token_file_allowed() && keychain_unavailable(&e) => {
            note_token_fallback(&e);
            token_file_set(&token_file(&app)?, &token)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Clears both places. Signing out must not leave a token behind in the file
/// because the keychain happened to be running this time and not last time.
#[tauri::command]
fn workspace_token_clear(app: tauri::AppHandle) -> R<()> {
    let keychain = match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) if token_file_allowed() && keychain_unavailable(&e) => {
            note_token_fallback(&e);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    };
    if token_file_allowed() {
        token_file_clear(&token_file(&app)?)?;
    }
    keychain
}

/// The terminals a Linux desktop might have, most likely first, each with
/// the argv that starts it in a directory.
///
/// A table rather than a loop because the flag differs per program: ghostty
/// and gnome-terminal want `--working-directory=DIR` as one argument,
/// alacritty and foot take it as two, kitty calls it `--directory`, and
/// wezterm hides it behind a `start` subcommand. `$TERMINAL` is consulted
/// first, since on a window-manager desktop like Omarchy it is the one thing
/// that says which terminal the person actually uses; a value this table
/// does not know is started with no flags and the directory inherited.
/// `x-terminal-emulator` is Debian's alternatives entry and gnome-terminal is
/// what GNOME has; they come last because a desktop that has them usually
/// has one of the others too, and the others are the ones people chose.
// Compiled on every host so the tests below run on a Mac; only Linux calls it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LINUX_TERMINALS: [(&str, &[&str]); 7] = [
    ("ghostty", &["--working-directory={dir}"]),
    ("alacritty", &["--working-directory", "{dir}"]),
    ("kitty", &["--directory", "{dir}"]),
    ("foot", &["--working-directory", "{dir}"]),
    ("wezterm", &["start", "--cwd", "{dir}"]),
    ("x-terminal-emulator", &["--working-directory", "{dir}"]),
    ("gnome-terminal", &["--working-directory={dir}"]),
];

/// The argv for a terminal, given its program name and the directory; the
/// table's flags with `{dir}` filled in, or nothing for a terminal the table
/// has not met. The name is matched on its last path segment, so
/// `TERMINAL=/usr/bin/kitty` still gets kitty's flag.
// Compiled on every host so the tests below run on a Mac; only Linux calls it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn terminal_args(program: &str, dir: &str) -> Vec<String> {
    let name = Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    LINUX_TERMINALS
        .iter()
        .find(|(bin, _)| *bin == name)
        .map(|(_, args)| args.iter().map(|a| a.replace("{dir}", dir)).collect())
        .unwrap_or_default()
}

/// The programs `open_in_terminal` tries on Linux, in order: `$TERMINAL` when
/// it is set to something, then the table.
// Compiled on every host so the tests below run on a Mac; only Linux calls it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_terminal_candidates(terminal_var: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(t) = terminal_var.map(str::trim).filter(|t| !t.is_empty()) {
        out.push(t.to_string());
    }
    for (bin, _) in LINUX_TERMINALS {
        if !out.iter().any(|o| o == bin) {
            out.push(bin.to_string());
        }
    }
    out
}

/// Open a terminal window in the repository. macOS: whatever the default
/// terminal is not knowable cheaply, so Terminal.app — `open -a` falls back
/// to complaining usefully if it is somehow absent. Elsewhere: best effort.
#[tauri::command]
fn open_in_terminal(repo: String) -> R<()> {
    let p = safe_join(&repo, "")?;
    let path = p.to_string_lossy();
    #[cfg(target_os = "macos")]
    {
        exec("open", &["-a", "Terminal", &path]).map(|_| ())
    }
    #[cfg(target_os = "linux")]
    {
        // Spawned rather than run to completion: a terminal outlives this
        // call, and waiting on it would hold the command until the person
        // closed the window. The working directory is set on the process as
        // well as passed as a flag, so a terminal the table does not know
        // still opens in the right place. A program that is not installed
        // fails at spawn, which is what moves the loop to the next one.
        let terminal = std::env::var("TERMINAL").ok();
        let mut last_err = String::new();
        for program in linux_terminal_candidates(terminal.as_deref()) {
            let mut cmd = Command::new(&program);
            cmd.args(terminal_args(&program, &path));
            cmd.current_dir(p.as_path());
            match cmd.spawn() {
                Ok(_) => return Ok(()),
                Err(e) => last_err = format!("{program}: {e}"),
            }
        }
        Err(format!(
            "no terminal found: set TERMINAL, or install ghostty, alacritty, kitty, foot or wezterm ({last_err})"
        ))
    }
    #[cfg(target_os = "windows")]
    {
        // Windows Terminal first, where it is installed; a plain console
        // otherwise. Neither gets the path as text: `wt` takes it as its own
        // argument and `cmd` inherits it as a working directory, so a space
        // or an `&` in `C:\Users\First Last\` never meets a shell. Spawned
        // rather than run to completion — a terminal is expected to outlive
        // this call — and the fallback asks for a console of its own, since
        // this process has none to hand down.
        use std::os::windows::process::CommandExt;
        let wt = Command::new("wt").args(["-d", path.as_ref()]).spawn();
        if wt.is_ok() {
            return Ok(());
        }
        Command::new("cmd")
            .arg("/K")
            .current_dir(path.as_ref())
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to open a terminal: {e}"))
    }
}

// ---------------------------------------------------------------------------
// the `plans` command line
// ---------------------------------------------------------------------------

/// The repository named on the command line at launch, held until the
/// frontend boots and takes it. `take` rather than `get`: a reload of the
/// webview must not re-open a path from a launch long past.
#[derive(Default)]
pub struct CliOpen(std::sync::Mutex<Option<String>>);

/// The first non-flag argument, resolved against `cwd` to an existing
/// directory. `plans .` is the whole point, so relative paths must survive
/// the trip through exec; canonicalize also throws away trailing `/.`.
fn cli_repo_arg<S: AsRef<str>>(args: &[S], cwd: &Path) -> Option<String> {
    let raw = args.iter().skip(1).find(|a| !a.as_ref().starts_with('-'))?;
    let p = Path::new(raw.as_ref());
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    };
    abs.canonicalize()
        .ok()
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn cli_open_path(state: tauri::State<CliOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// The directories `install_cli` will write to, most preferred first.
///
/// Homebrew's bin comes first: on every recent macOS it is the one PATH entry
/// an admin user can write without sudo. On Linux the answer is
/// `~/.local/bin`, which the XDG base directory spec names for exactly this
/// and which bash, zsh and fish on most distributions already put on PATH;
/// `bin_dirs` picks per host.
const BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

fn bin_dirs() -> Vec<PathBuf> {
    if cfg!(target_os = "linux") {
        home_dir()
            .map(|h| vec![h.join(".local").join("bin")])
            .unwrap_or_default()
    } else {
        BIN_DIRS.iter().map(PathBuf::from).collect()
    }
}

/// Whether `dir` is one of the entries of this process's PATH. Compared as
/// paths rather than strings, so a trailing slash or a `~` the shell already
/// expanded does not make a folder look absent.
fn on_path(dir: &Path, path_var: Option<&std::ffi::OsStr>) -> bool {
    let Some(path_var) = path_var else {
        return false;
    };
    std::env::split_paths(path_var).any(|d| d == dir)
}

/// Where the `plans` script is installed, if it is, and whether it points at
/// *this* build.
///
/// The version is in the script's own comment, so a script left by an older
/// copy of the app reads as installed-but-stale rather than as absent. The
/// caller can then offer "Update" instead of claiming nothing is there.
///
/// On Windows there is nothing to find: the script is a `#!/bin/sh` file in
/// Homebrew's bin, and every line of that is macOS. The honest Windows shape
/// — a `plans.cmd` in a per-user directory, put on the PATH through the
/// registry — is a different mechanism with its own failure modes, and it
/// gets its own plan. Until then Settings hides the control, the way the
/// tmux feature hides on a machine without tmux.
#[tauri::command]
fn cli_status() -> Option<CliStatus> {
    if cfg!(windows) {
        return None;
    }
    let path_var = std::env::var_os("PATH");
    for dir in bin_dirs() {
        let dest = dir.join("plans");
        if let Ok(text) = std::fs::read_to_string(&dest) {
            return Some(CliStatus {
                path: dest.to_string_lossy().into_owned(),
                current: text.contains(&format!("Looped Plans ({})", env!("CARGO_PKG_VERSION"))),
                on_path: on_path(&dir, path_var.as_deref()),
            });
        }
    }
    None
}

/// Write a small `plans` script onto the PATH so `plans .` opens the current
/// repository in the app. The script backgrounds the app and quiets its
/// output, so the terminal gets its prompt back; a second invocation is
/// caught by the single-instance plugin and forwarded to the open window.
#[tauri::command]
fn install_cli() -> R<String> {
    if cfg!(windows) {
        return Err("the plans command is not available on Windows yet".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = format!(
        "#!/bin/sh\n# Installed by Looped Plans ({}). Opens a repository in the app.\n\"{}\" \"$@\" >/dev/null 2>&1 &\n",
        env!("CARGO_PKG_VERSION"),
        exe.display()
    );
    // Homebrew's bin first — on every recent macOS it is the one PATH entry
    // an admin user can write without sudo. On Linux the one candidate is
    // `~/.local/bin`, made if it is not there yet: it is the user's own
    // folder, and a fresh home has no reason to have it already.
    let mut last_err = String::new();
    for dir in bin_dirs() {
        if cfg!(target_os = "linux") {
            std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        if !dir.is_dir() {
            continue;
        }
        let dest = dir.join("plans");
        match std::fs::write(&dest, &script) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                        .map_err(|e| e.to_string())?;
                }
                return Ok(dest.to_string_lossy().into_owned());
            }
            Err(e) => last_err = format!("{}: {e}", dest.display()),
        }
    }
    Err(if last_err.is_empty() {
        "no writable bin directory found on PATH".into()
    } else {
        last_err
    })
}

// ---------------------------------------------------------------------------
// git commands
// ---------------------------------------------------------------------------

/// Which multi-step git operation, if any, is part-way through.
///
/// Read from the git directory rather than inferred from status codes: a
/// conflicted file tells you a merge *went wrong*, while these files tell you
/// one is still open, which is the thing the app needs to say.
fn in_progress(repo: &str) -> Option<String> {
    let dir = git(repo, &["rev-parse", "--git-dir"]).ok()?;
    let dir = Path::new(repo).join(dir.trim());
    for (file, name) in [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        if dir.join(file).exists() {
            return Some(name.to_string());
        }
    }
    None
}

fn parse_ahead_behind(repo: &str) -> (u32, u32, bool) {
    match git(
        repo,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) {
        Ok(s) => {
            let mut it = s.split_whitespace();
            let behind = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            let ahead = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            (ahead, behind, true)
        }
        Err(_) => (0, 0, false),
    }
}

#[tauri::command]
async fn git_status(repo: String, scope: Vec<String>) -> R<GitStatus> {
    // The whole tree by default: the panel shows every change, markdown or
    // not. A scope narrows it when a caller only cares about part of the repo.
    let mut args = vec!["status", "--porcelain=v1", "-uall", "--"];
    if scope.is_empty() {
        args.push(".");
    } else {
        for s in &scope {
            args.push(s.as_str());
        }
    }
    let raw = git(&repo, &args)?;

    let mut entries = Vec::new();
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let index = &line[0..1];
        let worktree = &line[1..2];
        let rest = &line[3..];
        // Renames come through as "old -> new"; keep the new path.
        let path = rest.split(" -> ").last().unwrap_or(rest).trim_matches('"');
        entries.push(StatusEntry {
            path: path.to_string(),
            index: index.to_string(),
            worktree: worktree.to_string(),
        });
    }

    let branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let (ahead, behind, has_upstream) = parse_ahead_behind(&repo);

    Ok(GitStatus {
        operation: in_progress(&repo),
        branch,
        ahead,
        behind,
        has_upstream,
        entries,
    })
}

#[tauri::command]
async fn git_diff(repo: String, rel_path: String, staged: bool) -> R<String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--no-color");
    args.push("--");
    args.push(&rel_path);
    let d = git(&repo, &args)?;
    if !d.trim().is_empty() {
        return Ok(d);
    }
    // Untracked files have no diff; show the file body instead.
    if !staged {
        if let Ok(text) = std::fs::read_to_string(safe_join(&repo, &rel_path)?) {
            return Ok(text
                .lines()
                .map(|l| format!("+{l}"))
                .collect::<Vec<_>>()
                .join("\n"));
        }
    }
    Ok(String::new())
}

/// The committed text of a file, for the live redline. An untracked or newly
/// added file has no committed side yet, which is an empty string, not an error.
#[tauri::command]
async fn git_head_text(repo: String, rel_path: String) -> R<String> {
    safe_join(&repo, &rel_path)?;
    match git(&repo, &["show", &format!("HEAD:{rel_path}")]) {
        Ok(text) => Ok(text),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn git_stage(repo: String, paths: Vec<String>) -> R<()> {
    let mut args = vec!["add", "--"];
    for p in &paths {
        args.push(p.as_str());
    }
    git(&repo, &args).map(|_| ())
}

#[tauri::command]
fn git_unstage(repo: String, paths: Vec<String>) -> R<()> {
    let mut args = vec!["restore", "--staged", "--"];
    for p in &paths {
        args.push(p.as_str());
    }
    git(&repo, &args).map(|_| ())
}

#[tauri::command]
fn git_discard(repo: String, paths: Vec<String>) -> R<()> {
    let mut args = vec!["checkout", "--"];
    for p in &paths {
        args.push(p.as_str());
    }
    git(&repo, &args).map(|_| ())
}

#[tauri::command]
fn git_commit(repo: String, message: String) -> R<String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    git(&repo, &["commit", "-m", &message])
}

#[tauri::command]
fn git_push(repo: String) -> R<String> {
    let (_, _, has_upstream) = parse_ahead_behind(&repo);
    if has_upstream {
        git(&repo, &["push"])
    } else {
        let branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        git(&repo, &["push", "-u", "origin", &branch])
    }
}

/// Does this repository have an opinion about `pull.rebase` already?
///
/// `git config --get` exits non-zero when the key is unset, so an `Err` here
/// means "unset" rather than "broken".
fn pull_configured(repo: &str) -> bool {
    git(repo, &["config", "--get", "pull.rebase"]).is_ok()
}

/// Pull, in the two ways `--ff-only` used to refuse.
///
/// `--autostash` sets uncommitted work aside and puts it back afterwards:
/// editing a plan is the normal state of this app, and a pull that fails
/// because you have unsaved thoughts is a pull that fails always.
///
/// `--rebase` is for the other refusal — local commits alongside remote ones.
/// This is a repository of prose, usually written by one person on more than
/// one machine, and a merge commit saying "I wrote a paragraph in two places"
/// records nothing anybody will read. It is passed only when the repository
/// has no `pull.rebase` of its own: someone who has configured a preference
/// has already answered this question.
///
/// Neither flag makes conflicts impossible. When one happens the repository
/// is left exactly as git left it — mid-rebase, or with the stash still in
/// the list — and the message says so, because finishing that is a terminal's
/// job and pretending otherwise would lose work.
#[tauri::command]
fn git_pull(repo: String) -> R<String> {
    let mut args = vec!["pull", "--autostash"];
    if !pull_configured(&repo) {
        args.push("--rebase");
    }
    git(&repo, &args).map_err(|e| {
        let mid = Path::new(&repo).join(".git");
        if mid.join("rebase-merge").exists() || mid.join("rebase-apply").exists() {
            format!("{e}\n\nThe rebase stopped part-way. Finish or abort it in a terminal.")
        } else {
            e
        }
    })
}

/// Newest first: the branch you want is overwhelmingly one you — or the
/// factory — touched this week, and alphabetical order is missed nowhere once
/// the list is searchable.
fn branch_lines(repo: &str, extra: &str) -> Vec<String> {
    let args = [
        "branch",
        extra,
        "--sort=-committerdate",
        "--format=%(refname:short)",
    ];
    git(repo, &args)
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Whether a ref exists — how a local branch is told from a remote-only one.
fn has_ref(repo: &str, name: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", name]).is_ok()
}

#[tauri::command]
fn git_branches(repo: String) -> R<BranchList> {
    let current = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    let branches = branch_lines(&repo, "--list");
    // Half the time the branch being looked for is a colleague's, or the
    // factory's, and exists only on origin. A search that silently lacks it
    // reads as "does not exist", which is worse than the scroll was.
    let remotes = branch_lines(&repo, "--remotes")
        .into_iter()
        .filter(|r| {
            // `origin/HEAD` is a symref, not somewhere to check out.
            if r.ends_with("/HEAD") {
                return false;
            }
            // A remote whose local branch already exists is that same branch,
            // and the list should offer it once.
            match r.split_once('/') {
                Some((_, short)) => !branches.iter().any(|b| b == short),
                None => true,
            }
        })
        .collect();
    Ok(BranchList {
        current,
        branches,
        remotes,
    })
}

#[tauri::command]
fn git_checkout(repo: String, branch: String) -> R<String> {
    // A local branch is checked out as asked — local names contain slashes too
    // (`plans/settings-json`), so the name alone cannot say which kind it is.
    if has_ref(&repo, &format!("refs/heads/{branch}")) {
        return git(&repo, &["checkout", &branch]);
    }
    // Otherwise `origin/thing` means the branch on origin: create the tracking
    // branch, or switch to the local one that has appeared under that name
    // since the list was fetched.
    let remote = has_ref(&repo, &format!("refs/remotes/{branch}"));
    match branch.split_once('/') {
        Some((_, short)) if remote && !has_ref(&repo, &format!("refs/heads/{short}")) => {
            git(&repo, &["checkout", "-b", short, "--track", &branch])
        }
        Some((_, short)) if remote => git(&repo, &["checkout", short]),
        _ => git(&repo, &["checkout", &branch]),
    }
}

/// Branch off the current HEAD and switch to it.
#[tauri::command]
fn git_create_branch(repo: String, name: String) -> R<String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a branch needs a name".into());
    }
    git(&repo, &["checkout", "-b", &name])
}

/// Fetch from the default remote, so ahead/behind counts mean something.
#[tauri::command]
fn git_fetch(repo: String) -> R<String> {
    git(&repo, &["fetch", "--prune"])
}

/// Who git says the user is, per repository — the only identity the app has.
/// Unset is not an error: comments are then written unattributed.
#[derive(Serialize)]
pub struct Identity {
    name: String,
    email: String,
}

#[tauri::command]
fn git_identity(repo: String) -> R<Identity> {
    Ok(Identity {
        name: git(&repo, &["config", "user.name"])
            .unwrap_or_default()
            .trim()
            .to_string(),
        email: git(&repo, &["config", "user.email"])
            .unwrap_or_default()
            .trim()
            .to_string(),
    })
}

#[tauri::command]
fn git_log(repo: String, scope: Vec<String>, limit: u32) -> R<String> {
    let n = format!("-{limit}");
    let mut args = vec![
        "log",
        n.as_str(),
        "--date=short",
        "--pretty=format:%h\u{1f}%ad\u{1f}%an\u{1f}%s",
    ];
    if !scope.is_empty() {
        args.push("--");
        for s in &scope {
            args.push(s.as_str());
        }
    }
    git(&repo, &args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// In development, wear a different face.
///
/// A dev build and an installed one are the same window with the same title,
/// and the wrong one gets typed into. The icon is the only part of an app you
/// see without looking at it, so that is where the difference goes: the same
/// page, with the mark in Night's red instead of amber.
///
/// Only macOS, because that is where this is developed, and only in debug
/// builds — a shipped bundle takes its icon from Info.plist and never reaches
/// this function.
#[cfg(all(debug_assertions, target_os = "macos"))]
fn wear_the_development_face() {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    // AppKit is main-thread-only, and a wrong icon is not worth a panic over.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(include_bytes!("../icons/icon-dev.png"));
    let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return;
    };
    // SAFETY: on the main thread, per the marker above.
    unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&icon)) };
}

/// Whether to start WebKitGTK with its DMA-BUF renderer off.
///
/// Under Wayland with the NVIDIA driver the webview renders black or
/// flickers; this is the known state of WebKitGTK, and the variable is the
/// documented way around it. Forced by `PLANS_WEBKIT_SAFE=1` for the
/// compositors and drivers this guess misses. Pure, so the decision can be
/// tested on any host; `linux_webkit_env` reads the machine and applies it.
// Compiled on every host so the tests below run on a Mac; only Linux calls it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn webkit_safe_needed(forced: Option<&str>, wayland: bool, nvidia: bool) -> bool {
    matches!(forced.map(str::trim), Some("1") | Some("true")) || (wayland && nvidia)
}

/// Set the WebKitGTK environment before the webview exists. WebKit reads
/// these variables when the first web view is created, which is inside the
/// Tauri builder, so this has to run first thing in `run`. A variable the
/// person already set is left alone; they know their machine better.
#[cfg(target_os = "linux")]
fn linux_webkit_env() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_some() {
        return;
    }
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland");
    // The proprietary driver registers itself in both places; either is
    // enough. Nouveau does not have the problem and does not appear here.
    let nvidia = Path::new("/proc/driver/nvidia/version").exists()
        || Path::new("/sys/module/nvidia").exists();
    let forced = std::env::var("PLANS_WEBKIT_SAFE").ok();
    if webkit_safe_needed(forced.as_deref(), wayland, nvidia) {
        eprintln!("plans: Wayland with the NVIDIA driver (or PLANS_WEBKIT_SAFE); setting {VAR}=1");
        std::env::set_var(VAR, "1");
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    linux_webkit_env();

    let builder = tauri::Builder::default();

    // Registered before every other plugin, as its docs require: a second
    // `plans <path>` hands its argv and cwd to the running instance here and
    // exits, instead of opening a second window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        use tauri::{Emitter, Manager};
        if let Some(path) = cli_repo_arg(&args, Path::new(&cwd)) {
            let _ = app.emit("cli-open", path);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // The updater downloads and replaces the running bundle; `process` is what
    // relaunches it afterwards. Both are desktop-only, and the check itself is
    // driven from the frontend so it never sits on the path to first paint.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .manage(agent::Agents::default())
        .manage(agent::scratch::Scratch::default())
        .manage(CliOpen(std::sync::Mutex::new(
            std::env::current_dir()
                .ok()
                .and_then(|cwd| cli_repo_arg(&std::env::args().collect::<Vec<_>>(), &cwd)),
        )))
        .invoke_handler(tauri::generate_handler![
            open_repo,
            cli_open_path,
            install_cli,
            cli_status,
            list_plans,
            list_dirs,
            stat_plan,
            search_plans,
            write_asset,
            perf_log,
            read_asset,
            read_plan,
            write_plan,
            create_file,
            create_folder,
            rename_plan,
            copy_plan,
            delete_plan,
            folder_census,
            delete_folder,
            existing_dirs,
            settings_read,
            settings_write,
            settings_stat,
            settings_write_schema,
            settings_open,
            reveal_in_finder,
            open_in_terminal,
            sync_user_skills,
            templates_sync,
            templates_open,
            workspace_token_get,
            workspace_token_set,
            workspace_token_clear,
            git_status,
            git_diff,
            git_head_text,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_branches,
            git_checkout,
            git_create_branch,
            git_fetch,
            git_log,
            git_identity,
            mux::mux_available,
            mux::mux_panes,
            mux::mux_start,
            mux::mux_send,
            agent::discover::agent_list,
            agent::discover::agent_install,
            agent::agent_prompt,
            agent::agent_cancel,
            agent::agent_set_config,
            agent::agent_permission,
            agent::agent_question,
            agent::agent_stop,
            agent::agent_fs_reply,
            agent::scratch::workspace_scratch,
            agent::scratch::workspace_scratch_forget,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // On `Ready` rather than in `setup`: AppKit finishes launching
            // after setup runs and puts its own icon back, so an icon set any
            // earlier is overwritten before anyone sees it.
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if matches!(_event, tauri::RunEvent::Ready) {
                wear_the_development_face();
            }
            // Agent sessions live as long as the window, so something has to
            // end them. Nothing else in this app owns a process that outlives
            // the request that made it.
            if matches!(_event, tauri::RunEvent::Exit) {
                agent::shutdown_all(_app);
            }
        });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
//
// The two things worth proving here are the ones that would be quiet if they
// broke: a path that escapes its repository, and a fingerprint that fails to
// notice a file changed underneath an edit. Everything else in this file is a
// thin wrapper over `git`, which tests itself.

#[cfg(test)]
mod tests {
    use super::*;

    // --- safe_join: the boundary between the UI and the filesystem ----------

    #[test]
    fn joins_paths_inside_the_repository() {
        let p = safe_join("/repo", "notes/plan.md").unwrap();
        assert_eq!(p, PathBuf::from("/repo/notes/plan.md"));
    }

    #[test]
    fn refuses_to_escape_the_repository() {
        for bad in ["../secrets", "notes/../../etc/passwd", "..", "a/../.."] {
            assert!(
                safe_join("/repo", bad).is_err(),
                "{bad} should not be allowed out of the repository",
            );
        }
    }

    #[test]
    fn refuses_absolute_paths() {
        assert!(safe_join("/repo", "/etc/passwd").is_err());
    }

    #[test]
    fn allows_a_leading_dot_segment() {
        // "./plan.md" is how a path can arrive from the UI and means the same
        // thing as "plan.md"; refusing it would be surprising.
        assert_eq!(
            safe_join("/repo", "./plan.md").unwrap(),
            PathBuf::from("/repo/./plan.md"),
        );
    }

    #[test]
    fn the_empty_path_is_the_repository_itself() {
        assert_eq!(safe_join("/repo", "").unwrap(), PathBuf::from("/repo"));
    }

    // --- Linux: the token file, the terminal table, the PATH check ---------
    //
    // Host-independent by construction: the file helpers take a path, the
    // terminal table takes a name, and `webkit_safe_needed` takes the facts
    // rather than reading them. The Linux-only glue around them is a few
    // lines of environment reading that only a Linux machine can exercise.

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plans-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_token_file_round_trips_and_clears() {
        let dir = scratch_dir("token");
        let p = dir.join("nested").join("token");
        assert_eq!(
            token_file_get(&p).unwrap(),
            None,
            "no file is not signed in"
        );
        token_file_set(&p, "abc").unwrap();
        assert_eq!(token_file_get(&p).unwrap().as_deref(), Some("abc"));
        // A second sign-in replaces the first, in full.
        token_file_set(&p, "z").unwrap();
        assert_eq!(token_file_get(&p).unwrap().as_deref(), Some("z"));
        token_file_clear(&p).unwrap();
        assert_eq!(token_file_get(&p).unwrap(), None);
        // Clearing what is already gone is fine: signing out twice is not a fault.
        token_file_clear(&p).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("token-mode");
        let p = dir.join("token");
        // A world-readable file left over from something else must be
        // tightened, since the mode at creation does not touch it.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&p, "old").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        token_file_set(&p, "secret").unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode was {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_missing_keychain_reaches_the_file() {
        assert!(keychain_unavailable(&keyring::Error::NoStorageAccess(
            "no D-Bus".into()
        )));
        assert!(keychain_unavailable(&keyring::Error::PlatformFailure(
            "no Secret Service".into()
        )));
        // The keychain answering is never a reason to go around it.
        assert!(!keychain_unavailable(&keyring::Error::NoEntry));
        assert!(!keychain_unavailable(&keyring::Error::Invalid(
            "attribute".into(),
            "value".into()
        )));
    }

    #[test]
    fn each_terminal_gets_its_own_working_directory_flag() {
        let d = "/home/me/repo";
        assert_eq!(
            terminal_args("ghostty", d),
            vec!["--working-directory=/home/me/repo"]
        );
        assert_eq!(
            terminal_args("alacritty", d),
            vec!["--working-directory", d]
        );
        assert_eq!(terminal_args("kitty", d), vec!["--directory", d]);
        assert_eq!(terminal_args("foot", d), vec!["--working-directory", d]);
        assert_eq!(terminal_args("wezterm", d), vec!["start", "--cwd", d]);
        assert_eq!(
            terminal_args("gnome-terminal", d),
            vec!["--working-directory=/home/me/repo"]
        );
        // $TERMINAL as a full path still finds its row.
        assert_eq!(terminal_args("/usr/bin/kitty", d), vec!["--directory", d]);
        // An unknown terminal gets no flags; the spawn's own cwd carries it.
        assert!(terminal_args("st", d).is_empty());
    }

    #[test]
    fn the_terminal_variable_goes_first_and_is_not_repeated() {
        let c = linux_terminal_candidates(Some("kitty"));
        assert_eq!(c[0], "kitty");
        assert_eq!(c.iter().filter(|x| *x == "kitty").count(), 1);
        assert_eq!(c.len(), LINUX_TERMINALS.len());

        let c = linux_terminal_candidates(Some("  "));
        assert_eq!(c[0], "ghostty", "blank TERMINAL is unset");

        let c = linux_terminal_candidates(None);
        assert_eq!(c.last().map(String::as_str), Some("gnome-terminal"));
    }

    #[test]
    fn the_path_check_compares_as_paths() {
        let var = std::env::join_paths(["/usr/bin", "/home/me/.local/bin"]).unwrap();
        assert!(on_path(Path::new("/home/me/.local/bin"), Some(&var)));
        assert!(!on_path(Path::new("/home/me/bin"), Some(&var)));
        assert!(!on_path(Path::new("/usr/bin"), None));
    }

    #[test]
    fn webkit_safe_mode_is_forced_or_inferred() {
        assert!(webkit_safe_needed(Some("1"), false, false));
        assert!(webkit_safe_needed(Some("true"), false, false));
        assert!(webkit_safe_needed(None, true, true));
        assert!(
            !webkit_safe_needed(None, true, false),
            "Wayland alone is fine"
        );
        assert!(
            !webkit_safe_needed(None, false, true),
            "X11 with NVIDIA is fine"
        );
        assert!(!webkit_safe_needed(Some("0"), true, false));
    }

    /*
     * `copy_plan` is the one command with two repositories, and the thing worth
     * asserting is that having two did not widen what gets through. Each side is
     * joined inside its own root and neither root ever sees the other's path, so
     * a hostile destination is refused exactly as a hostile source is — checked
     * here against `safe_join` itself, since the rest of this module deliberately
     * stays off the real filesystem.
     */
    #[test]
    fn a_copy_cannot_write_outside_its_destination() {
        let from = safe_join("/repo/one", "plan.md");
        assert!(from.is_ok(), "an ordinary source must still be allowed");
        for bad in ["../elsewhere/plan.md", "/etc/passwd", "a/../../out.md"] {
            assert!(
                safe_join("/repo/two", bad).is_err(),
                "{bad} should not be allowed out of the destination repository",
            );
        }
    }

    // --- stamps: how a write knows the file did not move underneath it ------

    #[test]
    fn the_same_bytes_give_the_same_stamp() {
        assert_eq!(stamp_of(b"# Plan\n"), stamp_of(b"# Plan\n"));
    }

    #[test]
    fn different_bytes_give_different_stamps() {
        assert_ne!(stamp_of(b"# Plan\n"), stamp_of(b"# Plan\n\n"));
        // A trailing newline is a real difference: it is exactly the byte the
        // serialiser used to drop.
        assert_ne!(stamp_of(b"text"), stamp_of(b"text\n"));
    }

    #[test]
    fn a_file_reverted_to_its_old_contents_reads_as_unchanged() {
        // Content-hashed rather than mtime-based, on purpose: an agent that
        // writes and undoes a change has not changed anything.
        let before = stamp_of(b"one");
        let after_edit = stamp_of(b"two");
        let reverted = stamp_of(b"one");
        assert_ne!(before, after_edit);
        assert_eq!(before, reverted);
    }

    #[test]
    fn a_missing_file_is_absent_rather_than_empty() {
        let missing = stamp_at(Path::new("/definitely/not/here.md"));
        assert_eq!(missing, ABSENT);
        // And "absent" must not collide with the stamp of an empty file, or
        // creating a file would look like no change at all.
        assert_ne!(missing, stamp_of(b""));
    }

    // --- frontmatter status: read from the head, cached by mtime ------------

    #[test]
    fn status_is_read_from_the_frontmatter_head() {
        let dir = std::env::temp_dir().join("plans-status-test");
        std::fs::create_dir_all(&dir).unwrap();

        let with = dir.join("with.md");
        std::fs::write(
            &with,
            "---\ntitle: x\nStatus: \"Active\"\n- item\n---\n# hi\n",
        )
        .unwrap();
        assert_eq!(frontmatter_status(&with, 1), Some("Active".into()));

        // A status outside a frontmatter block is prose, not metadata.
        let without = dir.join("without.md");
        std::fs::write(&without, "# hi\nstatus: nope\n").unwrap();
        assert_eq!(frontmatter_status(&without, 1), None);

        // An indented status belongs to something nested, and is not the file's.
        let nested = dir.join("nested.md");
        std::fs::write(&nested, "---\nmeta:\n  status: inner\n---\n").unwrap();
        assert_eq!(frontmatter_status(&nested, 1), None);

        // Cached by mtime: an unchanged stamp returns the old answer without a
        // read; a moved stamp sees the new text.
        std::fs::write(&with, "---\nstatus: done\n---\n").unwrap();
        assert_eq!(frontmatter_status(&with, 1), Some("Active".into()));
        assert_eq!(frontmatter_status(&with, 2), Some("done".into()));
    }

    // --- what counts as markdown, and what is skipped -----------------------

    #[test]
    fn a_rename_that_only_changes_case_is_recognised() {
        assert!(case_only_rename("plan.md", "Plan.md"));
        assert!(case_only_rename("notes/plan.md", "notes/PLAN.md"));
        // Not case-only: a different name, or the same one.
        assert!(!case_only_rename("plan.md", "plans.md"));
        assert!(!case_only_rename("plan.md", "plan.md"));
        // A move is not a case change either, even with the same letters.
        assert!(!case_only_rename("a/plan.md", "b/plan.md"));
    }

    #[test]
    fn a_link_climbs_out_of_the_documents_folder() {
        assert_eq!(link_from("readme.md", "assets/a.png"), "assets/a.png");
        assert_eq!(
            link_from("notes/plan.md", "assets/a.png"),
            "../assets/a.png"
        );
        assert_eq!(
            link_from("notes/deep/plan.md", "assets/a.png"),
            "../../assets/a.png",
        );
    }

    #[test]
    fn build_directories_are_skipped() {
        for dir in ["node_modules", "target", ".git", "dist"] {
            assert!(SKIP_DIRS.contains(&dir), "{dir} should be skipped");
        }
    }
}
