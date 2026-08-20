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
pub fn cancel_all(perms: &Pending, _repo: &str, _chat: &str) {
    let waiting: Vec<_> = perms.lock().unwrap().drain().collect();
    for (_, tx) in waiting {
        let _ = tx.send(None);
    }
}

/// Ask, and wait.
///
/// Always asked, never answered on your behalf. The app briefly had a setting
/// for that, which was a second answer to a question the agent already asks
/// itself: every ACP agent advertises a permission mode, and its Auto or
/// Accept Edits settings decide these without a human far better than a
/// blanket switch here could. One control, and it is the agent's.
pub async fn permission(
    app: AppHandle,
    repo: String,
    chat: String,
    perms: Pending,
    req: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let raw = serde_json::to_value(&req).unwrap_or(json!({}));
    /*
     * The chat is in the id, not only the repository.
     *
     * A tool call id is the agent's, and unique within its own session — so
     * two sessions in one repository can mint the same one. Keyed by
     * repository alone, answering a question in one chat could resolve the
     * identically-named question in the other: unreliable in exactly the case
     * of two agents running, which is the case this is for.
     */
    let request_id = format!(
        "{}::{}::{}",
        repo,
        chat,
        raw["toolCall"]["toolCallId"].as_str().unwrap_or("?")
    );

    let (tx, rx) = oneshot::channel();
    perms.lock().unwrap().insert(request_id.clone(), tx);
    let _ = app.emit(
        "agent-permission",
        json!({
            "repo": repo,
            "chat": chat,
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
        json!({ "repo": repo, "chat": chat, "requestId": request_id, "chosen": chosen }),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The deadlock this module exists to avoid.
    ///
    /// While the agent waits on a permission it does nothing else, so every
    /// way the app can stop caring about the question has to answer it
    /// anyway. Cancel is the one people actually press.
    #[tokio::test]
    async fn cancelling_answers_every_outstanding_question() {
        let perms = pending();
        let (tx, rx) = oneshot::channel();
        perms.lock().unwrap().insert("r::t1".into(), tx);

        cancel_all(&perms, "r", "c");

        // Answered, and answered with "no" — not left hanging, and not
        // silently allowed.
        assert_eq!(rx.await.unwrap(), None);
        assert!(perms.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_answer_reaches_the_question_that_asked_it() {
        let perms = pending();
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();
        perms.lock().unwrap().insert("r::a".into(), tx1);
        perms.lock().unwrap().insert("r::b".into(), tx2);

        answer(&perms, "r::b", Some("allow".into()));

        assert_eq!(rx2.await.unwrap(), Some("allow".into()));
        // The other is untouched, not collaterally cancelled.
        assert_eq!(perms.lock().unwrap().len(), 1);
        cancel_all(&perms, "r", "c");
        assert_eq!(rx1.await.unwrap(), None);
    }

    #[tokio::test]
    async fn answering_a_question_nobody_asked_is_not_a_panic() {
        // A stale click from a transcript whose session has gone.
        let perms = pending();
        answer(&perms, "r::gone", Some("allow".into()));
    }
}
