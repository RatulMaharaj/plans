//! The half of the protocol where the agent asks *us*.
//!
//! Only one question so far: may I do this? It is the hardest thing in the
//! module for a reason that is easy to state and easy to get wrong — while the
//! agent waits on our answer it does nothing else, so every way this app can
//! stop caring about a question must still answer it. Cancel, a closed panel,
//! a switched repo, a quit: each of those has to resolve the request, or the
//! session is wedged behind a dialog nobody is looking at.

use agent_client_protocol::schema::v1::{
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAction,
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

/*
 * The agent's *questions*, as opposed to its permission checks.
 *
 * Claude's AskUserQuestion arrives as a form elicitation: a message plus a
 * JSON schema whose fields are the options. The answer is a content object
 * against that schema rather than a single option id, which is why this is a
 * second map rather than a second kind of entry in `Pending` — the payload is
 * a different shape, but the lifecycle (asked, answered, or given up on) is
 * the same, and every way the app can stop caring must still answer.
 */

/// Elicitations waiting on a human, by request id. The payload is the accept
/// content; `Value::Null` means "skipped" (decline) and a dropped or cancelled
/// sender means the tool call is aborted.
pub type Asks = Arc<Mutex<HashMap<String, oneshot::Sender<Option<serde_json::Value>>>>>;

pub fn asks() -> Asks {
    Arc::new(Mutex::new(HashMap::new()))
}

/// The UI's answer to a question: content for accept, `Null` for skip,
/// `None` for "we are not going to answer".
pub fn answer_ask(asks: &Asks, request_id: &str, content: Option<serde_json::Value>) {
    if let Some(tx) = asks.lock().unwrap().remove(request_id) {
        let _ = tx.send(content);
    }
}

/// Give up on every outstanding elicitation at once — same contract as
/// `cancel_all`: the agent is blocked on us, so silence is not an option.
pub fn cancel_asks(asks: &Asks) {
    let waiting: Vec<_> = asks.lock().unwrap().drain().collect();
    for (_, tx) in waiting {
        let _ = tx.send(None);
    }
}

/// Which question this is, among all the ones any session has asked. The
/// elicitation request carries no id of its own, so we mint one.
static NEXT_ASK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Ask the human a structured question, and wait.
///
/// The schema travels to the UI whole: which fields are selects, which are
/// free text, and what the options are is the agent's business, and the panel
/// draws what it is given the same way it draws config options.
pub async fn question(
    app: AppHandle,
    repo: String,
    chat: String,
    asks: Asks,
    req: CreateElicitationRequest,
    responder: Responder<CreateElicitationResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let raw = serde_json::to_value(&req).unwrap_or(json!({}));
    // A URL elicitation has no form to draw; declining our own advertised
    // capability set is a bug, but an unknown mode still has to be answered.
    if raw["mode"] != json!("form") {
        return responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
    }
    let request_id = format!(
        "{}::{}::ask-{}",
        repo,
        chat,
        NEXT_ASK.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let (tx, rx) = oneshot::channel();
    asks.lock().unwrap().insert(request_id.clone(), tx);
    let _ = app.emit(
        "agent-question",
        json!({
            "repo": repo,
            "chat": chat,
            "requestId": request_id,
            "message": raw["message"],
            "schema": raw["requestedSchema"],
        }),
    );

    let chosen = rx.await.ok().flatten();
    // What to show for it afterwards: the answers for an accept, `{}` for a
    // deliberate skip, `null` for a cancel — a skipped question and an
    // abandoned one read differently in the transcript.
    let done = match &chosen {
        Some(v) if !v.is_null() => v.clone(),
        Some(_) => json!({}),
        None => json!(null),
    };
    let _ = app.emit(
        "agent-question-done",
        json!({ "repo": repo, "chat": chat, "requestId": request_id, "chosen": done }),
    );
    let response = match chosen {
        // Accept is deserialized rather than built: the content is arbitrary
        // schema-shaped JSON, and the wire type already knows how to read it.
        Some(content) if !content.is_null() => {
            serde_json::from_value(json!({ "action": "accept", "content": content }))
                .unwrap_or_else(|_| CreateElicitationResponse::new(ElicitationAction::Cancel))
        }
        // Skipped on purpose: the model is told the user moved past the
        // question, which is not the same as aborting the tool call.
        Some(_) => CreateElicitationResponse::new(ElicitationAction::Decline),
        None => CreateElicitationResponse::new(ElicitationAction::Cancel),
    };
    responder.respond(response)
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

    /// Elicitations share the permission contract: every way the app can stop
    /// caring about one must still answer it, or the agent waits forever.
    #[tokio::test]
    async fn cancelling_answers_every_outstanding_elicitation() {
        let a = asks();
        let (tx, rx) = oneshot::channel();
        a.lock().unwrap().insert("r::c::ask-1".into(), tx);

        cancel_asks(&a);

        assert_eq!(rx.await.unwrap(), None);
        assert!(a.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_answer_reaches_the_elicitation_that_asked_it() {
        let a = asks();
        let (tx, rx) = oneshot::channel();
        a.lock().unwrap().insert("r::c::ask-2".into(), tx);

        answer_ask(&a, "r::c::ask-2", Some(json!({ "question_0": "Refactor" })));

        assert_eq!(rx.await.unwrap(), Some(json!({ "question_0": "Refactor" })));
        // A stale answer to a question already gone is a no-op, not a panic.
        answer_ask(&a, "r::c::ask-2", Some(json!(null)));
    }
}
