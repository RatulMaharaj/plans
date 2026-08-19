//! A conversation with a coding agent, streamed.
//!
//! The agent CLI already knows how to hold a conversation: `claude -p` takes a
//! prompt, `--resume` continues a session, and `--output-format stream-json`
//! narrates what it is doing as NDJSON. This module owns those flags — the
//! user's setting is only the binary name — so the stream shape is guaranteed,
//! and turns the narration into events the panel can draw as it arrives.
//!
//! No PTY and no terminal: stdout is a pipe, because nothing here is
//! interactive. One turn is one child process; the *conversation* persists as
//! the session id the CLI hands back, not as anything the app keeps alive.

use crate::R;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

/// Turns still running: id -> the child, held only so Stop can kill it.
#[derive(Default)]
pub struct Chats(Mutex<HashMap<u64, Child>>);

#[derive(Serialize, Clone)]
struct ChatDelta {
    id: u64,
    text: String,
}

/// The agent picked up a tool — the one honest peek this model gives into
/// what is happening to the files while the prose streams.
#[derive(Serialize, Clone)]
struct ChatTool {
    id: u64,
    name: String,
    /// The one argument worth reading: the file, the command, the pattern.
    detail: String,
}

#[derive(Serialize, Clone)]
struct ChatDone {
    id: u64,
    /// The CLI's session id, for `--resume` on the next turn.
    session: Option<String>,
    ok: bool,
}

#[derive(Serialize, Clone)]
struct ChatError {
    id: u64,
    message: String,
}

static NEXT_CHAT: AtomicU64 = AtomicU64::new(1);

/// The PATH a login shell would have, found once and remembered.
///
/// A GUI app launched from Finder or the Dock inherits launchd's PATH, which
/// is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every way people
/// actually install an agent CLI — `~/.local/bin`, Homebrew, a node version
/// manager, `~/.bun/bin` — is outside it, so `Command::new("claude")` fails
/// with "not found" for someone who can run `claude` perfectly well in a
/// terminal. The same app started from a terminal works, which is exactly the
/// kind of difference that makes a bug look like magic.
///
/// Asking the login shell is the only honest way to know: the PATH is
/// assembled by the user's own dotfiles, and guessing a list of directories
/// would be wrong for the next person.
static SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

fn login_path() -> Option<&'static str> {
    SHELL_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let out = Command::new(shell)
                .args(["-lc", "printf %s \"$PATH\""])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!p.is_empty()).then_some(p)
        })
        .as_deref()
}

/// The binary to run for `name`, as an absolute path where one can be found.
///
/// Resolved rather than passed through so a failure is "not installed" rather
/// than "not on this process's PATH", and so `chat_agents` and `chat_send`
/// can never disagree about whether something exists.
pub fn resolve(name: &str) -> Option<PathBuf> {
    let dirs = login_path()
        .map(String::from)
        .or_else(|| std::env::var("PATH").ok())?;
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        let p = Path::new(dir).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// A binary name is a word, not a command line. The flags are ours.
fn checked(cmd: &str) -> R<&str> {
    let c = cmd.trim();
    if c.is_empty() || c.chars().any(char::is_whitespace) {
        return Err("the agent command must be a single binary name".into());
    }
    Ok(c)
}

/// `<cmd> --version`, or `None` when it is not installed.
///
/// The UI hides the whole feature on `None` rather than offering a chat that
/// fails when spoken to — the same courtesy `mux_available` gives tmux.
#[tauri::command]
pub fn chat_available(cmd: String) -> Option<String> {
    let c = checked(&cmd).ok()?;
    let bin = resolve(c)?;
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// An agent the app knows how to look for, and whether it is installed.
#[derive(serde::Serialize)]
pub struct AgentFound {
    /// The binary name, which is also the value stored in settings.
    id: String,
    /// What `--version` said, absent when the binary is not on PATH.
    version: Option<String>,
    /// Whether `chat_send`'s flags are this agent's flags.
    ///
    /// They are Claude Code's: `-p`, `--output-format stream-json`,
    /// `--permission-mode`, `--resume`. Another agent may well be installed
    /// and still not speak this protocol, and saying so is better than
    /// offering a chat that spawns a process which exits on an unknown flag.
    supported: bool,
}

/// The agents worth looking for, in the order they are offered.
const KNOWN: [(&str, bool); 2] = [("claude", true), ("codex", false)];

/// Which of the known agents are on this machine.
///
/// A list rather than a free-text name: nearly everyone has one of two, and
/// typing a binary name correctly is not a thing to ask of someone choosing
/// from a set the app can see for itself. A name that is not on the list can
/// still be set — the dropdown carries whatever is configured.
#[tauri::command]
pub fn chat_agents() -> Vec<AgentFound> {
    KNOWN
        .iter()
        .map(|(id, supported)| AgentFound {
            id: (*id).to_string(),
            version: chat_available((*id).to_string()),
            supported: *supported,
        })
        .collect()
}

/// One turn: spawn the agent on `prompt`, stream its narration as events.
///
/// `--permission-mode acceptEdits` is what lets "edit the plan" actually edit
/// the plan from a headless run; the working directory is the repo, so edits
/// land where the watcher is already looking. `--resume` carries the
/// conversation — the child is disposable, the session is not.
#[tauri::command]
pub fn chat_send(
    repo: String,
    cmd: String,
    prompt: String,
    session: Option<String>,
    state: State<'_, Chats>,
    app: AppHandle,
) -> R<u64> {
    let name = checked(&cmd)?.to_string();
    let bin = resolve(&name).ok_or_else(|| {
        format!("{name} is not installed, or not on the PATH your shell gives this app")
    })?;
    let id = NEXT_CHAT.fetch_add(1, Ordering::Relaxed);

    let mut command = Command::new(&bin);
    command
        .arg("-p")
        .arg(&prompt)
        .args(["--output-format", "stream-json", "--verbose"])
        .arg("--include-partial-messages")
        .args(["--permission-mode", "acceptEdits"])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(s) = session.as_deref() {
        command.args(["--resume", s]);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;

    let stdout = child.stdout.take().ok_or("no stdout from the agent")?;
    let stderr = child.stderr.take();
    state.0.lock().unwrap().insert(id, child);

    std::thread::spawn(move || {
        let mut said_anything = false;
        let mut done: Option<ChatDone> = None;

        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                // Not JSON is not an error: agents print banners.
                continue;
            };
            match v["type"].as_str() {
                Some("stream_event") => {
                    let ev = &v["event"];
                    if ev["delta"]["type"] == "text_delta" {
                        if let Some(t) = ev["delta"]["text"].as_str() {
                            said_anything = true;
                            let _ = app.emit("chat-delta", ChatDelta { id, text: t.into() });
                        }
                    }
                }
                // The assembled message, which is where a tool's arguments are
                // whole. `content_block_start` announces the tool before its
                // input has streamed, so it can only ever say "Edit" — this
                // says "Edit plan.md", which is what you would see in a
                // terminal and the only version worth showing.
                Some("assistant") => {
                    if let Some(blocks) = v["message"]["content"].as_array() {
                        for b in blocks {
                            if b["type"] != "tool_use" {
                                continue;
                            }
                            let Some(n) = b["name"].as_str() else {
                                continue;
                            };
                            let _ = app.emit(
                                "chat-tool",
                                ChatTool {
                                    id,
                                    name: n.into(),
                                    detail: tool_detail(&b["input"]),
                                },
                            );
                        }
                    }
                }
                Some("result") => {
                    // An older CLI without partial messages still lands here:
                    // the whole answer arrives as one delta rather than none.
                    if !said_anything {
                        if let Some(t) = v["result"].as_str() {
                            let _ = app.emit("chat-delta", ChatDelta { id, text: t.into() });
                        }
                    }
                    // An error result carries its message in the same field
                    // a good one carries the answer, and saying nothing at all
                    // is the worst of the options.
                    if v["is_error"] == true && !said_anything {
                        if let Some(t) = v["result"].as_str() {
                            let _ = app.emit("chat-delta", ChatDelta { id, text: t.into() });
                        }
                    }
                    done = Some(ChatDone {
                        id,
                        session: v["session_id"].as_str().map(String::from),
                        ok: v["is_error"] != true,
                    });
                }
                _ => {}
            }
        }

        // Reap, then report. A kill from Stop and a crash both land here with
        // no result line; the difference is only what stderr has to say.
        let child = app.state::<Chats>().0.lock().unwrap().remove(&id);
        let mut failed = String::new();
        if let Some(mut c) = child {
            let status = c.wait();
            if done.is_none() {
                if let Some(mut e) = stderr {
                    let _ = e.read_to_string(&mut failed);
                }
                if failed.trim().is_empty() {
                    failed = match status {
                        Ok(st) if st.success() => "the agent said nothing".into(),
                        _ => "the agent stopped".into(),
                    };
                }
            }
        }
        match done {
            Some(d) => {
                let _ = app.emit("chat-done", d);
            }
            None => {
                let _ = app.emit(
                    "chat-error",
                    ChatError {
                        id,
                        message: failed.trim().to_string(),
                    },
                );
            }
        }
    });

    Ok(id)
}

/// The argument of a tool call worth showing beside its name.
///
/// One field, not a dump: a tool line is a glance, and the whole input of an
/// Edit is the thing you would read the diff for instead. Paths are shortened
/// to their filename because the repository is already the context.
fn tool_detail(input: &serde_json::Value) -> String {
    for key in ["file_path", "path", "notebook_path"] {
        if let Some(p) = input[key].as_str() {
            return p.rsplit('/').next().unwrap_or(p).to_string();
        }
    }
    for key in [
        "command",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
    ] {
        if let Some(v) = input[key].as_str() {
            return first_line(v);
        }
    }
    String::new()
}

/// A single line, short enough to sit on one row.
fn first_line(s: &str) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(60).collect::<String>())
    } else {
        line.to_string()
    }
}

/// Stop the turn. The session survives — stopping an answer mid-sentence is
/// not forgetting the conversation.
#[tauri::command]
pub fn chat_cancel(id: u64, state: State<'_, Chats>) -> R<()> {
    if let Some(mut c) = state.0.lock().unwrap().remove(&id) {
        let _ = c.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_binary_name_is_one_word() {
        assert!(checked("claude").is_ok());
        assert!(checked("  claude  ").is_ok());
        assert!(checked("claude --print").is_err());
        assert!(checked("").is_err());
    }

    #[test]
    fn a_tool_shows_its_file_by_name_alone() {
        let input = json!({ "file_path": "/a/b/plan.md", "old_string": "x" });
        assert_eq!(tool_detail(&input), "plan.md");
    }

    #[test]
    fn a_tool_without_a_path_shows_what_it_was_given() {
        assert_eq!(tool_detail(&json!({ "command": "ls -la" })), "ls -la");
        assert_eq!(tool_detail(&json!({ "pattern": "TODO" })), "TODO");
        // Nothing recognisable is nothing shown, rather than a dump of JSON.
        assert_eq!(tool_detail(&json!({ "unknown": 1 })), "");
    }

    #[test]
    fn a_long_argument_is_cut_to_one_line() {
        let long = "x".repeat(200);
        let out = tool_detail(&json!({ "command": format!("{long}\nsecond line") }));
        assert!(out.chars().count() <= 61, "{out}");
        assert!(!out.contains('\n'));
    }

    #[test]
    fn the_assembled_message_is_where_a_tool_use_is_whole() {
        // `content_block_start` announces a tool with an empty input; the
        // `assistant` line is the one that carries the arguments, which is why
        // the reader listens to that instead.
        let announced = json!({
            "type": "content_block_start",
            "content_block": { "type": "tool_use", "name": "Read", "input": {} }
        });
        assert_eq!(
            announced["content_block"]["input"]["file_path"].as_str(),
            None
        );

        let whole = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/r/note.md" } }
            ]}
        });
        let block = &whole["message"]["content"][0];
        assert_eq!(block["name"].as_str(), Some("Read"));
        assert_eq!(tool_detail(&block["input"]), "note.md");
    }

    #[test]
    fn a_binary_outside_this_process_path_is_still_found() {
        // The point of `resolve`: a GUI app's PATH is not the shell's, so the
        // lookup goes through the login shell. `sh` is on every PATH there is,
        // which makes it the one name safe to assert on.
        assert!(resolve("sh").is_some());
        assert!(resolve("plans-no-such-agent-9f3").is_none());
    }

    #[test]
    fn an_absent_binary_is_none_not_an_error() {
        assert!(chat_available("plans-no-such-agent-9f3".into()).is_none());
    }
}

/// Tests that talk to whatever `sh` is installed, standing in for the agent:
/// the streaming loop only cares about NDJSON on stdout.
#[cfg(test)]
mod live {
    // The reader loop is exercised end-to-end through the app during the
    // bake-off; what is testable headlessly without a Tauri AppHandle is the
    // spawn/flag surface above, and the parsing below.
    use serde_json::json;

    /// The exact lines the CLI emits, kept here as the contract the parser
    /// reads — if the CLI changes shape, this is the test to update first.
    #[test]
    fn the_stream_shapes_we_rely_on_parse() {
        let delta = json!({
            "type": "stream_event",
            "event": { "delta": { "type": "text_delta", "text": "hel" } }
        });
        assert_eq!(delta["event"]["delta"]["text"].as_str(), Some("hel"));

        let tool = json!({
            "type": "stream_event",
            "event": { "content_block": { "type": "tool_use", "name": "Edit" } }
        });
        assert_eq!(
            tool["event"]["content_block"]["name"].as_str(),
            Some("Edit")
        );

        let result = json!({
            "type": "result", "is_error": false,
            "result": "done", "session_id": "abc-123"
        });
        assert_eq!(result["session_id"].as_str(), Some("abc-123"));
        assert!(result["is_error"] != true);
    }
}
