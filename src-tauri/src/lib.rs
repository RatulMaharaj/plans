use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

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

fn git(repo: &str, args: &[&str]) -> R<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        })
    }
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
            if let Ok(mut out) = found.lock() {
                out.push(PlanFile {
                    rel_path: rel,
                    name,
                    dir,
                    modified,
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

#[tauri::command]
fn rename_plan(repo: String, from: String, to: String) -> R<()> {
    let a = safe_join(&repo, &from)?;
    let b = safe_join(&repo, &to)?;
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

// ---------------------------------------------------------------------------
// git commands
// ---------------------------------------------------------------------------

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

#[tauri::command]
fn git_pull(repo: String) -> R<String> {
    git(&repo, &["pull", "--ff-only"])
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
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            list_plans,
            stat_plan,
            search_plans,
            write_asset,
            perf_log,
            read_asset,
            read_plan,
            write_plan,
            create_plan,
            rename_plan,
            delete_plan,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

    // --- what counts as markdown, and what is skipped -----------------------

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
