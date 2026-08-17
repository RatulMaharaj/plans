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

/// The subset of `paths` that .gitignore excludes.
///
/// `git check-ignore` exits 1 when nothing matches, which is not an error, so
/// this drives the process directly rather than going through `git()`.
fn ignored_paths(repo: &str, paths: &[String]) -> std::collections::HashSet<String> {
    use std::io::Write;
    let mut set = std::collections::HashSet::new();
    if paths.is_empty() {
        return set;
    }
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["check-ignore", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return set;
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(paths.join("\n").as_bytes());
    }
    let Ok(out) = child.wait_with_output() else {
        return set;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let l = line.trim().trim_matches('"');
        if !l.is_empty() {
            set.insert(l.replace('\\', "/"));
        }
    }
    set
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

fn collect_markdown(dir: &Path, root: &Path, out: &mut Vec<PlanFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            collect_markdown(&p, root, out);
            continue;
        }
        let ext = p
            .extension()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            continue;
        }
        let rel = match p.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let modified = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let parent = rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        out.push(PlanFile {
            rel_path: rel,
            name,
            dir: parent,
            modified,
        });
    }
}

#[tauri::command]
fn list_plans(repo: String, dirs: Vec<String>, include_ignored: bool) -> R<Vec<PlanFile>> {
    let root = PathBuf::from(&repo);
    let mut out = Vec::new();
    for d in dirs {
        let abs = safe_join(&repo, &d)?;
        if abs.is_dir() {
            collect_markdown(&abs, &root, &mut out);
        }
    }
    if !include_ignored {
        let paths: Vec<String> = out.iter().map(|f| f.rel_path.clone()).collect();
        let ignored = ignored_paths(&repo, &paths);
        out.retain(|f| !ignored.contains(&f.rel_path));
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
    let bytes =
        std::fs::read(&p).map_err(|e| format!("could not read {rel_path}: {e}"))?;
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
    match git(repo, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) {
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
    let mut args = vec!["status", "--porcelain=v1", "-uall", "--"];
    for s in &scope {
        args.push(s.as_str());
    }
    // With no scope, drop the trailing `--` separator argument set.
    let raw = if scope.is_empty() {
        git(&repo, &["status", "--porcelain=v1", "-uall"])?
    } else {
        git(&repo, &args)?
    };

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
        branches: raw.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
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
