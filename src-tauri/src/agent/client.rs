//! The half of the protocol where the agent asks *us*.
//!
//! Only one question so far: may I do this? It is the hardest thing in the
//! module for a reason that is easy to state and easy to get wrong — while the
//! agent waits on our answer it does nothing else, so every way this app can
//! stop caring about a question must still answer it. Cancel, a closed panel,
//! a switched repo, a quit: each of those has to resolve the request, or the
//! session is wedged behind a dialog nobody is looking at.

use agent_client_protocol::schema::v1::{
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome,
};
use agent_client_protocol::Responder;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// Questions waiting on a human, by request id.
pub type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>;

pub fn pending() -> Pending {
    Arc::new(Mutex::new(HashMap::new()))
}

/// The UI's answer: an option id, or `None` for "we are not going to answer".
pub fn answer(perms: &Pending, request_id: &str, option_id: Option<String>) {
    if let Some(tx) = perms.lock().unwrap().remove(request_id) {
        let _ = tx.send(option_id);
    }
}

/// Give up on every outstanding question at once.
pub fn cancel_all(perms: &Pending, _repo: &str) {
    let waiting: Vec<_> = perms.lock().unwrap().drain().collect();
    for (_, tx) in waiting {
        let _ = tx.send(None);
    }
}

/// Ask, and wait.
///
/// Stage 1 answers for you: the mode the adapter starts in already decides
/// these without a human, and this app's files are markdown under git, so the
/// worst case is a diff you can read. `AUTO_ALLOW` is the switch stage 2
/// turns off; the plumbing is here so that turning it off is a UI change
/// rather than a protocol change.
pub async fn permission(
    app: AppHandle,
    repo: String,
    perms: Pending,
    req: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let raw = serde_json::to_value(&req).unwrap_or(json!({}));
    let request_id = format!(
        "{}::{}",
        repo,
        raw["toolCall"]["toolCallId"].as_str().unwrap_or("?")
    );

    let first = req.options.first().map(|o| o.option_id.clone());

    if AUTO_ALLOW.load(std::sync::atomic::Ordering::Relaxed) {
        return match first {
            Some(id) => responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
            )),
            None => responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            )),
        };
    }

    let (tx, rx) = oneshot::channel();
    perms.lock().unwrap().insert(request_id.clone(), tx);
    let _ = app.emit(
        "agent-permission",
        json!({
            "repo": repo,
            "requestId": request_id,
            "title": raw["toolCall"]["title"],
            "options": raw["options"],
        }),
    );

    // A dropped sender is a cancelled question, not a hung one: if whatever
    // was going to answer has gone away, the agent still gets a reply.
    let chosen = rx.await.ok().flatten();
    let _ = app.emit(
        "agent-permission-done",
        json!({ "repo": repo, "requestId": request_id, "chosen": chosen }),
    );
    match chosen {
        Some(id) => responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
        )),
        None => responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        )),
    }
}

/// Whether permission requests are answered for you.
///
/// Global rather than per-session because it is a preference, and a preference
/// that differed between two repositories in the same window would be a thing
/// nobody could keep in their head.
pub static AUTO_ALLOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
