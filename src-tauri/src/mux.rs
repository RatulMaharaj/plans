//! Terminal multiplexer sessions, currently tmux.
//!
//! The app does not own the agent's process: tmux runs it, keeps it alive
//! across app restarts, and serves it to any terminal. What lives here is
//! discovery (which panes belong to this repo), starting a run in a window of
//! its own, and a headless answer path. Every call is one short-lived
//! subprocess in the shape of `git()`: explicit argv, no shell, stderr
//! surfaced as the error.

use crate::{exec, R};
use serde::Serialize;
use std::path::Path;

/// The field list for `list-panes`, and the order the parser expects.
///
/// Tab-separated because a pane's path may contain spaces and its command
/// certainly can; tabs are the one character tmux will not hand back inside
/// any of these fields.
const PANE_FORMAT: &str = "#{pane_id}\t#{session_name}:#{window_index}\t\
     #{pane_current_command}\t#{pane_dead}\t#{pane_width}\t#{pane_height}\t\
     #{pane_current_path}";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    /// tmux's own id, `%17`. Stable for the pane's whole life, unlike the
    /// window index, which renumbers whenever an earlier window closes.
    pub id: String,
    /// `session:window`, for showing a human where this is.
    pub target: String,
    /// The foreground command, `zsh` when nothing is running.
    pub command: String,
    pub dead: bool,
    pub width: u32,
    pub height: u32,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MuxInfo {
    pub kind: String,
    pub version: String,
}

/// `tmux -V`, or `None` when tmux is not installed.
///
/// The UI hides the whole feature on `None` rather than offering something that
/// fails when pressed.
#[tauri::command]
pub fn mux_available() -> Option<MuxInfo> {
    let v = exec("tmux", &["-V"]).ok()?;
    Some(MuxInfo {
        kind: "tmux".into(),
        version: v.trim().to_string(),
    })
}

/// True when `path` is `repo` or sits inside it.
///
/// Compared component-wise rather than with `starts_with` on the strings, so
/// that `/proj/plans-old` is not treated as living inside `/proj/plans`.
fn within(repo: &Path, path: &str) -> bool {
    let p = Path::new(path);
    p == repo || p.starts_with(repo)
}

fn parse_panes(out: &str, repo: &Path) -> Vec<Pane> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 7 {
                return None;
            }
            let path = f[6].trim().to_string();
            if !within(repo, &path) {
                return None;
            }
            Some(Pane {
                id: f[0].to_string(),
                target: f[1].to_string(),
                command: f[2].to_string(),
                dead: f[3] == "1",
                width: f[4].parse().unwrap_or(0),
                height: f[5].parse().unwrap_or(0),
                path,
            })
        })
        .collect()
}

/// Every pane on the server whose working directory is inside `repo`.
///
/// One subprocess for the whole server. Matching is on the pane's own cwd, not
/// on the session name or `session_path`: a session named for a project
/// routinely reports a different directory from the windows inside it, so the
/// name is a convention and the pane's path is the fact.
///
/// No tmux server running is not an error — it is an empty list. Starting the
/// app before opening a terminal is normal.
#[tauri::command]
pub fn mux_panes(repo: String) -> R<Vec<Pane>> {
    let root = Path::new(&repo);
    match exec("tmux", &["list-panes", "-a", "-F", PANE_FORMAT]) {
        Ok(out) => Ok(parse_panes(&out, root)),
        Err(e) if no_server(&e) => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// tmux says this in a few different wordings depending on version and whether
/// the socket exists at all.
fn no_server(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("no server running")
        || e.contains("no current session")
        || e.contains("error connecting")
        || e.contains("no sessions")
}

/// Open a window in `repo` running `argv`, and return the new pane's id.
///
/// `-d` creates it without moving the user's focus, which is the whole point:
/// the run starts, and they carry on reading. `-P -F '#{pane_id}'` prints the
/// id, which is the handle everything else here takes.
///
/// `-c` sets the working directory, so a repo-relative path in `argv` is
/// unambiguous without us resolving it.
#[tauri::command]
pub fn mux_start(repo: String, argv: Vec<String>) -> R<String> {
    if argv.is_empty() {
        return Err("nothing to run".into());
    }
    let mut args: Vec<&str> = vec![
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-c",
        repo.as_str(),
    ];
    // tmux takes the command as separate words after the options; it execs them
    // directly rather than handing the line to a shell.
    args.extend(argv.iter().map(|s| s.as_str()));
    let out = exec("tmux", &args)?;
    let id = out.trim().to_string();
    if id.is_empty() {
        return Err("tmux did not return a pane id".into());
    }
    Ok(id)
}

/// Send `text` to the pane, optionally following it with Enter.
///
/// `-l` is load-bearing. Without it tmux reads the argument as key *names*, so
/// sending the word "up" presses the up arrow and sending "C-c" kills the job.
/// With it, the text arrives as typed.
///
/// Submitting is a second call rather than a newline inside the text, because
/// many TUIs bind Enter to something other than "insert a newline".
#[tauri::command]
pub fn mux_send(id: String, text: String, submit: bool) -> R<()> {
    if !text.is_empty() {
        exec("tmux", &["send-keys", "-t", id.as_str(), "-l", text.as_str()])?;
    }
    if submit {
        exec("tmux", &["send-keys", "-t", id.as_str(), "Enter"])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "/Users/x/Projects/plans";

    fn line(id: &str, path: &str) -> String {
        format!("{id}\tplans:2\tzsh\t0\t80\t24\t{path}")
    }

    #[test]
    fn keeps_panes_inside_the_repository() {
        let out = line("%1", REPO);
        let panes = parse_panes(&out, Path::new(REPO));
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].id, "%1");
        assert_eq!(panes[0].target, "plans:2");
        assert_eq!(panes[0].width, 80);
    }

    #[test]
    fn keeps_panes_in_subdirectories() {
        let out = line("%2", "/Users/x/Projects/plans/src-tauri");
        assert_eq!(parse_panes(&out, Path::new(REPO)).len(), 1);
    }

    #[test]
    fn drops_panes_in_other_repositories() {
        let out = line("%3", "/Users/x/Projects/other");
        assert!(parse_panes(&out, Path::new(REPO)).is_empty());
    }

    /// The reason matching is component-wise: a sibling whose name merely
    /// starts with the repo's name is not inside it.
    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_inside() {
        let out = line("%4", "/Users/x/Projects/plans-old");
        assert!(parse_panes(&out, Path::new(REPO)).is_empty());
    }

    /// Session names are a convention, not a key: the session called `plans`
    /// reports a different directory from the windows living in it.
    #[test]
    fn ignores_the_session_name_and_uses_the_pane_path() {
        let out = format!(
            "%5\tplans:1\tzsh\t0\t80\t24\t/Users/x/projects\n{}",
            line("%6", REPO)
        );
        let panes = parse_panes(&out, Path::new(REPO));
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].id, "%6");
    }

    #[test]
    fn reads_the_dead_flag() {
        let out = format!("%7\tplans:3\tnode\t1\t80\t24\t{REPO}");
        let panes = parse_panes(&out, Path::new(REPO));
        assert!(panes[0].dead);
        assert_eq!(panes[0].command, "node");
    }

    #[test]
    fn survives_a_short_or_empty_line() {
        let out = format!("\ngarbage\n{}", line("%8", REPO));
        assert_eq!(parse_panes(&out, Path::new(REPO)).len(), 1);
    }

    #[test]
    fn a_path_with_spaces_still_parses() {
        let p = "/Users/x/Projects/plans/some dir";
        let panes = parse_panes(&line("%9", p), Path::new(REPO));
        assert_eq!(panes[0].path, p);
    }

    #[test]
    fn recognises_a_stopped_server() {
        assert!(no_server("no server running on /tmp/tmux-501/default"));
        assert!(no_server("error connecting to /tmp/tmux-501/default"));
        assert!(!no_server("can't find pane %9"));
    }
}

/// Tests that talk to the tmux actually installed on this machine.
///
/// They create their own throwaway session and remove it, so they never touch
/// a session anyone is using. Skipped entirely when tmux is absent, because a
/// machine without it is a supported machine.
#[cfg(test)]
mod live {
    use super::*;

    fn have_tmux() -> bool {
        mux_available().is_some()
    }

    /// What the pane shows, straight from tmux — the live tests' eyes now that
    /// the app reads through an attached client instead of `capture-pane`.
    fn capture(id: &str) -> String {
        exec("tmux", &["capture-pane", "-p", "-t", id]).unwrap()
    }

    /// Each test gets a session of its own name, because cargo runs them in
    /// parallel and a shared name is a race.
    fn cleanup(s: &str) {
        let _ = exec("tmux", &["kill-session", "-t", s]);
    }

    #[test]
    fn starts_a_pane_and_finds_it_again() {
        if !have_tmux() {
            return;
        }
        const S: &str = "plans-selftest-start";
        cleanup(S);
        let repo = std::env::current_dir().unwrap();
        let repo = repo.to_string_lossy().to_string();
        exec("tmux", &["new-session", "-d", "-s", S, "-c", &repo]).unwrap();

        // The flag combination the whole feature rests on: a detached window
        // that hands back a stable id.
        let id = mux_start(
            repo.clone(),
            vec!["sh".into(), "-c".into(), "echo marker-9f3; sleep 20".into()],
        )
        .expect("new-window -P -F should return a pane id");
        assert!(id.starts_with('%'), "expected a pane id, got {id:?}");

        std::thread::sleep(std::time::Duration::from_millis(600));
        let screen = capture(&id);
        assert!(screen.contains("marker-9f3"), "capture-pane said {screen:?}");

        // And it is discoverable by the repo it is running in.
        let found = mux_panes(repo).unwrap();
        assert!(found.iter().any(|p| p.id == id), "pane not found by path");

        cleanup(S);
    }

    /// `-l` is the difference between typing a word and pressing a key.
    #[test]
    fn send_keys_types_text_rather_than_pressing_it() {
        if !have_tmux() {
            return;
        }
        const S: &str = "plans-selftest-send";
        cleanup(S);
        let repo = std::env::current_dir().unwrap();
        let repo = repo.to_string_lossy().to_string();
        exec("tmux", &["new-session", "-d", "-s", S, "-c", &repo]).unwrap();
        let id = mux_start(
            repo,
            vec!["sh".into(), "-c".into(), "read x; echo got:$x; sleep 20".into()],
        )
        .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(400));
        // "Up" would be the arrow key without -l, and never reach `read`.
        mux_send(id.clone(), "Up".into(), true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));

        let screen = capture(&id);
        assert!(screen.contains("got:Up"), "screen was {screen:?}");

        cleanup(S);
    }
}
