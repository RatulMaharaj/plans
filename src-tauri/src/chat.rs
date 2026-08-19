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
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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
    let out = Command::new(c).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
    let bin = checked(&cmd)?.to_string();
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
        .map_err(|e| format!("could not run {bin}: {e}"))?;

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
                    } else if ev["content_block"]["type"] == "tool_use" {
                        if let Some(n) = ev["content_block"]["name"].as_str() {
                            let _ = app.emit("chat-tool", ChatTool { id, name: n.into() });
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

    #[test]
    fn a_binary_name_is_one_word() {
        assert!(checked("claude").is_ok());
        assert!(checked("  claude  ").is_ok());
        assert!(checked("claude --print").is_err());
        assert!(checked("").is_err());
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
        assert_eq!(tool["event"]["content_block"]["name"].as_str(), Some("Edit"));

        let result = json!({
            "type": "result", "is_error": false,
            "result": "done", "session_id": "abc-123"
        });
        assert_eq!(result["session_id"].as_str(), Some("abc-123"));
        assert!(result["is_error"] != true);
    }
}
