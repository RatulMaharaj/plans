//! A folder an agent is allowed to believe in.
//!
//! A workspace file has no path: its truth is a Yjs document on the wire. An
//! agent wants a working directory all the same — its shell, its grep, its
//! listing tools all read disk — so each workspace gets a folder under the
//! app's cache directory, written from the room's tree and rewritten whenever
//! the room changes. The room stays the truth; this is the copy the agent
//! starts in. Reads and writes the agent routes through the client are caught
//! in `client.rs` and answered from the room, which is what keeps the copy
//! from ever being the thing that is edited.

use crate::R;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Which workspace each scratch folder stands in for, by folder.
#[derive(Default)]
pub struct Scratch(Mutex<HashMap<PathBuf, String>>);

/// One line of the tree as the frontend hands it over: a path within the
/// workspace, whether it is a file or a folder, and — for a file — its text.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchFile {
    pub path: String,
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
}

/// Where a workspace's folder lives: `<cache>/workspaces/<id>`.
fn folder_for(app: &AppHandle, id: &str) -> R<PathBuf> {
    // The id is the server's, and opaque — but it is about to become a path
    // segment, so anything that could climb out of the cache is refused.
    if id.is_empty() || id.contains(['/', '\\', '\0']) || id == "." || id == ".." {
        return Err("not a workspace id".into());
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory: {e}"))?;
    Ok(cache.join("workspaces").join(id))
}

/// The scratch folder's idea of a relative path: forward slashes, no
/// climbing, nothing absolute.
fn safe_rel(path: &str) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// Write the tree into `folder`, and take out whatever is there that the
/// tree no longer names.
///
/// A file whose text is already what the tree says is left alone, so an
/// agent watching mtimes does not see every file change on every keystroke
/// in one of them. Everything else under the folder goes: it is a cache, and
/// a file the tree does not know about is a file the workspace does not have.
pub fn materialise(folder: &Path, files: &[ScratchFile]) -> R<()> {
    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let mut keep: HashSet<PathBuf> = HashSet::new();
    for f in files {
        let Some(rel) = safe_rel(&f.path) else {
            continue;
        };
        // Every ancestor is kept too, or a folder holding only files would be
        // swept as unnamed.
        for a in rel.ancestors() {
            if !a.as_os_str().is_empty() {
                keep.insert(folder.join(a));
            }
        }
        let at = folder.join(&rel);
        if f.kind == "folder" {
            std::fs::create_dir_all(&at).map_err(|e| format!("{}: {e}", at.display()))?;
            continue;
        }
        if let Some(parent) = at.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let text = f.text.as_deref().unwrap_or("");
        if std::fs::read_to_string(&at).ok().as_deref() != Some(text) {
            std::fs::write(&at, text).map_err(|e| format!("{}: {e}", at.display()))?;
        }
    }
    sweep(folder, &keep)?;
    Ok(())
}

/// Remove everything under `dir` that is not in `keep`.
fn sweep(dir: &Path, keep: &HashSet<PathBuf>) -> R<()> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if keep.contains(&p) {
            if is_dir {
                sweep(&p, keep)?;
            }
            continue;
        }
        let gone = if is_dir {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p)
        };
        gone.map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

/// Write a workspace's tree to its scratch folder and remember the folder.
/// Answers with the folder, which is what the chat starts its agent in.
#[tauri::command]
pub fn workspace_scratch(app: AppHandle, id: String, files: Vec<ScratchFile>) -> R<String> {
    let folder = folder_for(&app, &id)?;
    materialise(&folder, &files)?;
    let state: State<Scratch> = app.state();
    state.0.lock().unwrap().insert(folder.clone(), id);
    Ok(folder.display().to_string())
}

/// Stop routing a folder's reads and writes to the room. The files stay; the
/// next chat writes over them.
#[tauri::command]
pub fn workspace_scratch_forget(app: AppHandle, id: String) -> R<()> {
    let folder = folder_for(&app, &id)?;
    let state: State<Scratch> = app.state();
    state.0.lock().unwrap().remove(&folder);
    Ok(())
}

/// The workspace and the path within it that `path` stands for, if it is
/// under a registered scratch folder.
pub fn workspace_for(app: &AppHandle, path: &Path) -> Option<(String, String)> {
    let state = app.try_state::<Scratch>()?;
    let folders = state.0.lock().unwrap();
    for (folder, id) in folders.iter() {
        if let Some(rel) = under(folder, path) {
            return Some((id.clone(), rel));
        }
    }
    None
}

/// `path` relative to `folder`, forward slashes, when it is inside it.
pub fn under(folder: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(folder).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, text: &str) -> ScratchFile {
        ScratchFile {
            path: path.into(),
            kind: "file".into(),
            text: Some(text.into()),
        }
    }

    fn dir(path: &str) -> ScratchFile {
        ScratchFile {
            path: path.into(),
            kind: "folder".into(),
            text: None,
        }
    }

    #[test]
    fn the_folder_is_the_tree_and_nothing_else() {
        let tmp = tempdir();
        materialise(
            &tmp,
            &[
                file("plan.md", "# Plan\n"),
                dir("notes"),
                file("notes/a.md", "a"),
            ],
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.join("plan.md")).unwrap(),
            "# Plan\n"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.join("notes/a.md")).unwrap(),
            "a"
        );

        // A file the agent left behind, and a file the tree dropped, both go.
        std::fs::write(tmp.join("stray.txt"), "x").unwrap();
        materialise(&tmp, &[file("plan.md", "# Plan\n"), dir("notes")]).unwrap();
        assert!(!tmp.join("stray.txt").exists());
        assert!(!tmp.join("notes/a.md").exists());
        assert!(tmp.join("notes").is_dir());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn a_path_that_climbs_is_skipped() {
        let tmp = tempdir();
        materialise(&tmp, &[file("../escape.md", "no"), file("/abs.md", "no")]).unwrap();
        assert!(!tmp.parent().unwrap().join("escape.md").exists());
        assert!(std::fs::read_dir(&tmp).unwrap().next().is_none());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn under_answers_the_workspace_path() {
        let f = Path::new("/cache/workspaces/abc");
        assert_eq!(
            under(f, Path::new("/cache/workspaces/abc/notes/a.md")),
            Some("notes/a.md".into())
        );
        assert_eq!(under(f, Path::new("/cache/workspaces/abc")), None);
        assert_eq!(under(f, Path::new("/cache/workspaces/abcd/x.md")), None);
        assert_eq!(under(f, Path::new("/elsewhere/x.md")), None);
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "plans-scratch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
