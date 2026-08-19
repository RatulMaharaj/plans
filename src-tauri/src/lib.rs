use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub mod chat;
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
    let out = Command::new(bin)
        .args(args)
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
}

#[derive(Serialize, Deserialize)]
pub struct BranchList {
    current: String,
    branches: Vec<String>,
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

/// Walking a repository for markdown.
///
/// This was a hand-rolled recursive read_dir followed by one
/// `git check-ignore --stdin` over every path found. On a repository with a few
/// thousand markdown files that is a full single-threaded tree walk plus a
/// subprocess, on every poll — which is what made the app crawl.
///
/// `ignore` is ripgrep's walker: parallel across cores, and it reads .gitignore
/// itself, so the subprocess disappears entirely.
fn walk_markdown(root: &Path, include_ignored: bool) -> Vec<PlanFile> {
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
            if ext != "md" && ext != "markdown" {
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
            let status = frontmatter_status(path, modified);
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

#[tauri::command]
fn list_plans(repo: String, dirs: Vec<String>, include_ignored: bool) -> R<Vec<PlanFile>> {
    let root = PathBuf::from(&repo);
    let mut out = Vec::new();
    // An empty entry means the repository itself, which is the only caller now.
    if dirs.is_empty() || dirs.iter().any(|d| d.is_empty()) {
        out = walk_markdown(&root, include_ignored);
    } else {
        for d in dirs {
            let abs = safe_join(&repo, &d)?;
            if abs.is_dir() {
                out.extend(walk_markdown(&abs, include_ignored));
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

/// Search inside the markdown of a repository./// Search inside the markdown of a repository.
///
/// Filenames answer "which file was that", and are already searchable. This
/// answers the other question — "where did I write about X" — which for notes
/// is the one asked more often. Plain substring, case-insensitive: a regular
/// expression is a different feature, and most searches are neither.
#[tauri::command]
fn search_plans(repo: String, query: String, include_ignored: bool, limit: u32) -> R<Vec<Hit>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let root = PathBuf::from(&repo);
    let files = walk_markdown(&root, include_ignored);
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

#[tauri::command]
fn create_plan(repo: String, rel_path: String, title: String) -> R<()> {
    let p = safe_join(&repo, &rel_path)?;
    if p.exists() {
        return Err(format!("{rel_path} already exists"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, format!("# {title}\n\n")).map_err(|e| e.to_string())
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

/// Show the file or folder in the platform's file manager, selected.
#[tauri::command]
fn reveal_in_finder(repo: String, rel_path: String) -> R<()> {
    let p = safe_join(&repo, &rel_path)?;
    tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
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
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
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
/// an admin user can write without sudo.
const BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// Where the `plans` script is installed, if it is, and whether it points at
/// *this* build.
///
/// The version is in the script's own comment, so a script left by an older
/// copy of the app reads as installed-but-stale rather than as absent. The
/// caller can then offer "Update" instead of claiming nothing is there.
#[tauri::command]
fn cli_status() -> Option<CliStatus> {
    for dir in BIN_DIRS {
        let dest = Path::new(dir).join("plans");
        if let Ok(text) = std::fs::read_to_string(&dest) {
            return Some(CliStatus {
                path: dest.to_string_lossy().into_owned(),
                current: text.contains(&format!("Plans ({})", env!("CARGO_PKG_VERSION"))),
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
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = format!(
        "#!/bin/sh\n# Installed by Plans ({}). Opens a repository in the app.\n\"{}\" \"$@\" >/dev/null 2>&1 &\n",
        env!("CARGO_PKG_VERSION"),
        exe.display()
    );
    // Homebrew's bin first — on every recent macOS it is the one PATH entry
    // an admin user can write without sudo.
    let mut last_err = String::new();
    for dir in BIN_DIRS {
        if !Path::new(dir).is_dir() {
            continue;
        }
        let dest = Path::new(dir).join("plans");
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
fn git_status(repo: String, scope: Vec<String>) -> R<GitStatus> {
    // Only markdown. Enumerating every untracked file in a large repository is
    // most of what this command costs, and none of it is ever shown.
    let mut args = vec!["status", "--porcelain=v1", "-uall", "--"];
    if scope.is_empty() {
        args.push("*.md");
        args.push("*.markdown");
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
fn git_diff(repo: String, rel_path: String, staged: bool) -> R<String> {
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
fn git_head_text(repo: String, rel_path: String) -> R<String> {
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

#[tauri::command]
fn git_branches(repo: String) -> R<BranchList> {
    let raw = git(&repo, &["branch", "--format=%(refname:short)"])?;
    let current = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    Ok(BranchList {
        current,
        branches: raw
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
    })
}

#[tauri::command]
fn git_checkout(repo: String, branch: String) -> R<String> {
    git(&repo, &["checkout", &branch])
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

pub fn run() {
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
        .manage(chat::Chats::default())
        .manage(CliOpen(std::sync::Mutex::new(
            std::env::current_dir().ok().and_then(|cwd| {
                cli_repo_arg(&std::env::args().collect::<Vec<_>>(), &cwd)
            }),
        )))
        .invoke_handler(tauri::generate_handler![
            open_repo,
            cli_open_path,
            install_cli,
            cli_status,
            list_plans,
            stat_plan,
            search_plans,
            write_asset,
            perf_log,
            read_asset,
            read_plan,
            write_plan,
            create_plan,
            create_folder,
            rename_plan,
            delete_plan,
            folder_census,
            delete_folder,
            existing_dirs,
            reveal_in_finder,
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
            chat::chat_available,
            chat::chat_agents,
            chat::chat_send,
            chat::chat_cancel,
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
