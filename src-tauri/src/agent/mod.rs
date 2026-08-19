//! Talking to a coding agent over ACP.
//!
//! The app is not an agent and does not want to be one. It is a client: it
//! starts something that speaks the Agent Client Protocol, shows what that
//! thing says, and passes back what you type. Which models exist, which
//! reasoning levels, which slash commands, whether a tool needs asking about —
//! none of it is knowledge this app holds. The agent tells us, and we draw it.
//!
//! That is the whole argument for the rewrite this module replaced. The old
//! code built Claude Code's command line and parsed Claude Code's JSON, so
//! "which agent" could only ever be a list with one real entry, and a model
//! picker had nowhere to come from. Here a second agent is a row in a table.

pub mod client;
pub mod discover;
pub mod events;
pub mod session;

use crate::R;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// The turn a notification belongs to.
///
/// ACP's updates carry a session, not a turn — the session is the long-lived
/// thing and the protocol has no reason to care which prompt is in flight.
/// The panel does care, because it routes late events to the right transcript,
/// so updates are stamped with the turn most recently sent. One at a time per
/// session is the model here, which is what makes a single value enough.
pub static CURRENT_TURN: AtomicU64 = AtomicU64::new(0);
static NEXT_TURN: AtomicU64 = AtomicU64::new(1);

struct Live {
    ops: UnboundedSender<session::Op>,
    perms: client::Pending,
}

/// One agent per repository, keyed the way the transcript already is.
#[derive(Default)]
pub struct Agents(Mutex<HashMap<String, Live>>);

/// Start a session for `repo` if there is not one already.
///
/// Lazily, on the first thing anyone says — booting an agent process for
/// someone who opens the panel and then closes it again is rude, and the
/// handshake can prompt for authentication.
fn ensure(app: &AppHandle, repo: &str, agent_id: &str) -> R<()> {
    let state: State<Agents> = app.state();
    if state.0.lock().unwrap().contains_key(repo) {
        return Ok(());
    }
    let argv = discover::argv_for(agent_id).ok_or_else(|| {
        format!("{agent_id} is not installed, or not on the PATH this app was given")
    })?;

    let (tx, rx) = unbounded_channel();
    let perms = client::pending();
    state.0.lock().unwrap().insert(
        repo.to_string(),
        Live {
            ops: tx,
            perms: perms.clone(),
        },
    );

    let (a, r) = (app.clone(), repo.to_string());
    tauri::async_runtime::spawn(async move {
        session::run(a.clone(), r.clone(), argv, rx, perms).await;
        // However it ended, it is no longer live: the next prompt starts a
        // fresh one rather than writing into a channel nobody reads.
        if let Some(s) = a.try_state::<Agents>() {
            s.0.lock().unwrap().remove(&r);
        }
    });
    Ok(())
}

fn send(app: &AppHandle, repo: &str, op: session::Op) -> R<()> {
    let state: State<Agents> = app.state();
    let live = state.0.lock().unwrap();
    let l = live
        .get(repo)
        .ok_or("no agent is running for this repository")?;
    l.ops
        .send(op)
        .map_err(|_| "the agent has stopped".to_string())
}

/// Say something. Starts the session if this is the first thing said.
#[tauri::command]
pub fn agent_prompt(app: AppHandle, repo: String, agent: String, text: String) -> R<u64> {
    ensure(&app, &repo, &agent)?;
    let turn = NEXT_TURN.fetch_add(1, Ordering::Relaxed);
    send(&app, &repo, session::Op::Prompt { turn, text })?;
    Ok(turn)
}

#[tauri::command]
pub fn agent_cancel(app: AppHandle, repo: String, turn: u64) -> R<()> {
    send(&app, &repo, session::Op::Cancel { turn })
}

#[tauri::command]
pub fn agent_set_config(app: AppHandle, repo: String, id: String, value: String) -> R<()> {
    send(&app, &repo, session::Op::SetConfig { id, value })
}

/// Answer a permission request. `option` of `None` means "cancelled".
#[tauri::command]
pub fn agent_permission(
    app: AppHandle,
    repo: String,
    request_id: String,
    option: Option<String>,
) -> R<()> {
    let state: State<Agents> = app.state();
    let live = state.0.lock().unwrap();
    if let Some(l) = live.get(&repo) {
        client::answer(&l.perms, &request_id, option);
    }
    Ok(())
}

/// Whether the app answers permission requests on your behalf.
#[tauri::command]
pub fn agent_auto_allow(on: bool) -> R<()> {
    client::AUTO_ALLOW.store(on, Ordering::Relaxed);
    Ok(())
}

/// Stop a repository's agent. Also what quitting does, for every one of them.
#[tauri::command]
pub fn agent_stop(app: AppHandle, repo: String) -> R<()> {
    let state: State<Agents> = app.state();
    let live = state.0.lock().unwrap().remove(&repo);
    if let Some(l) = live {
        client::cancel_all(&l.perms, &repo);
        let _ = l.ops.send(session::Op::Shutdown);
    }
    let _ = app.emit("agent-down", json!({ "repo": repo, "message": "" }));
    Ok(())
}

/// Shut every session down.
///
/// Called on quit. The old design's children lived for one turn and cleaned
/// themselves up; these live as long as the window, and a `node` per
/// repository left behind after the app closes is the regression this exists
/// to prevent.
pub fn shutdown_all(app: &AppHandle) {
    let Some(state) = app.try_state::<Agents>() else {
        return;
    };
    let all: Vec<_> = state.0.lock().unwrap().drain().collect();
    for (repo, l) in all {
        client::cancel_all(&l.perms, &repo);
        let _ = l.ops.send(session::Op::Shutdown);
    }
}
