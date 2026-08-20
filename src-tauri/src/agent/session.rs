//! One agent process, for as long as a repository is being talked to.
//!
//! This is the inversion ACP brings. The old design's unit of work was a turn:
//! spawn a CLI, parse its output, let it die. Here the unit is a *session* —
//! a process that outlives every turn, holds the session id, tells us what
//! models and commands it has, and can ask us questions back. Everything
//! awkward in this file (the op channel, the shutdown handling) exists because
//! something now lives longer than the request that created it.
//!
//! The connection runs on Tauri's own async runtime. The 2.x SDK is
//! `Send`-friendly and needs no thread or local set of its own, so a session
//! is a spawned task and nothing more.

use crate::agent::events;
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, LoadSessionRequest, NewSessionRequest, PromptRequest,
    SessionConfigOptionValue, SessionId, SessionNotification, SetSessionConfigOptionRequest,
    TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedReceiver;

/// What the UI can ask a live session to do.
pub enum Op {
    Prompt { turn: u64, text: String },
    Cancel { turn: u64 },
    SetConfig { id: String, value: String },
    Shutdown,
}

/// Run one session until the agent dies or we are told to stop.
///
/// `argv[0]` is an absolute program — resolution happened before we got here,
/// so a missing agent is reported as "not installed" rather than as a session
/// that starts and immediately fails.
pub async fn run(
    app: AppHandle,
    repo: String,
    // Which conversation this session is having. Fixed for its whole life, so
    // it is not on `Op` — putting it on every message would only restate the
    // key the session was found under.
    chat: String,
    // Which session this is. Carried onto the events that can outlive it, so
    // the panel can tell news about this session from news about its
    // successor — see `NEXT_GEN` in the parent module.
    gen: u64,
    argv: Vec<String>,
    // A session id from a previous run, if there is one to pick up.
    resume: Option<String>,
    mut ops: UnboundedReceiver<Op>,
    perms: crate::agent::client::Pending,
) {
    /*
     * The child needs the PATH a terminal would have, not the one we inherited.
     *
     * Resolving `npx` to an absolute path is only half the job: `npx` is a
     * script whose shebang is `#!/usr/bin/env node`, and `env` searches the
     * *child's* PATH. A GUI app launched from Finder hands down launchd's
     * PATH, which has no node — so the program we carefully found fails at
     * exit 127 with "env: node: No such file or directory", which reads like
     * the agent is broken rather than unfound.
     */
    let mut cfg = AcpAgentConfig::new(&argv[0]).args(argv[1..].iter().cloned());
    if let Some(path) = crate::agent::discover::login_path() {
        cfg = cfg.env("PATH", path);
    }
    let agent = AcpAgent::new(cfg);

    /*
     * The turn this session's narration belongs to.
     *
     * ACP's updates carry a session, not a turn — the session is the
     * long-lived thing and the protocol has no reason to care which prompt is
     * in flight. The panel does care, because it routes late events to the
     * right place, so updates are stamped with the turn most recently sent.
     *
     * Per session, and that is the whole point: this was a process-wide global
     * until two sessions could run at once, at which point whichever spoke
     * last stamped the other one's narration with its own turn.
     */
    let turn_now = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    let (r2, a2, c2, t2) = (repo.clone(), app.clone(), chat.clone(), turn_now.clone());
    let (r3, a3, c3, p3) = (repo.clone(), app.clone(), chat.clone(), perms.clone());
    // The connection closure takes ownership; these are what is left to report
    // with once it has finished, whichever way it finished.
    let (after_app, after_repo, after_chat, after_perms) =
        (app.clone(), repo.clone(), chat.clone(), perms.clone());

    let result =
        agent_client_protocol::Client
            .builder()
            .on_receive_notification(
                move |n: SessionNotification, _cx| {
                    let (app, repo, chat, turn) = (a2.clone(), r2.clone(), c2.clone(), t2.clone());
                    async move {
                        let raw = serde_json::to_value(&n.update).unwrap_or(json!({}));
                        let t = turn.load(std::sync::atomic::Ordering::Relaxed);
                        if let Some(e) = events::map(&repo, &chat, t, &raw) {
                            let _ = app.emit(e.name, e.payload);
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                move |req, responder, _c| {
                    let (app, repo, chat, pending) =
                        (a3.clone(), r3.clone(), c3.clone(), p3.clone());
                    async move {
                        crate::agent::client::permission(app, repo, chat, pending, req, responder)
                            .await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, |c: ConnectionTo<Agent>| async move {
                c.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                /*
                 * Pick up where the last process left off, when there is a
                 * session to pick up and the agent can. A crash mid-turn
                 * should cost the answer, not the conversation — and an agent
                 * without `loadSession` falls back to a new session, which is
                 * what would have happened anyway.
                 */
                let mut sid: Option<SessionId> = None;
                let mut options = json!(null);
                if let Some(id) = resume {
                    if let Ok(r) = c
                        .send_request(LoadSessionRequest::new(
                            id.clone(),
                            std::path::PathBuf::from(&repo),
                        ))
                        .block_task()
                        .await
                    {
                        // The id is the one we asked to load; the reply
                        // carries the state that goes with it.
                        options = serde_json::to_value(&r)
                            .map(|v| v["configOptions"].clone())
                            .unwrap_or(json!(null));
                        sid = Some(SessionId::from(id));
                        let _ = app.emit("agent-resumed", json!({ "repo": repo, "chat": chat }));
                    }
                }
                if sid.is_none() {
                    let opened = c
                        .send_request(NewSessionRequest::new(std::path::PathBuf::from(&repo)))
                        .block_task()
                        .await?;
                    options = serde_json::to_value(&opened)
                        .map(|v| v["configOptions"].clone())
                        .unwrap_or(json!(null));
                    sid = Some(opened.session_id);
                }
                let sid = sid.expect("a session, one way or the other");

                // Told to the UI so the next window can offer it back: this is
                // the whole of what resuming needs to remember.
                let _ = app.emit(
                    "agent-session",
                    json!({ "repo": repo, "chat": chat, "sessionId": sid.to_string() }),
                );

                // What the agent can do is news the moment it is known: the
                // pickers and the slash list are drawn from this, before anyone
                // has said anything.
                if !options.is_null() {
                    let _ = app.emit(
                        "agent-config",
                        json!({ "repo": repo, "chat": chat, "options": options }),
                    );
                }
                let _ = app.emit(
                    "agent-ready",
                    json!({ "repo": repo, "chat": chat, "gen": gen }),
                );

                while let Some(op) = ops.recv().await {
                    match op {
                        Op::Prompt { turn, text } => {
                            turn_now.store(turn, std::sync::atomic::Ordering::Relaxed);
                            let out = c
                                .send_request(PromptRequest::new(
                                    sid.clone(),
                                    vec![ContentBlock::Text(TextContent::new(text))],
                                ))
                                .block_task()
                                .await;
                            let stop = match &out {
                                Ok(r) => format!("{:?}", r.stop_reason),
                                Err(e) => format!("{e}"),
                            };
                            let _ = app.emit(
                            "agent-turn",
                            json!({ "repo": repo, "chat": chat, "turn": turn, "stop": stop, "ok": out.is_ok() }),
                        );
                        }
                        Op::Cancel { turn } => {
                            /*
                             * Answer every outstanding permission before asking
                             * the agent to stop. It is blocked on us; if we go
                             * quiet it waits forever and the session is wedged
                             * with no way back short of killing the process.
                             */
                            crate::agent::client::cancel_all(&perms, &repo, &chat);
                            let _ = app.emit(
                            "agent-turn",
                            json!({ "repo": repo, "chat": chat, "turn": turn, "stop": "cancelled", "ok": false }),
                        );
                        }
                        Op::SetConfig { id, value } => {
                            let sent = c
                                .send_request(SetSessionConfigOptionRequest::new(
                                    sid.clone(),
                                    id.clone(),
                                    SessionConfigOptionValue::ValueId {
                                        value: value.clone().into(),
                                    },
                                ))
                                .block_task()
                                .await;
                            // The agent returns the whole set, current values and
                            // all. Redrawing from its answer rather than from the
                            // click is what makes a picker honest when a choice
                            // changes what else is on offer.
                            if let Ok(r) = sent {
                                if let Ok(v) = serde_json::to_value(&r) {
                                    let _ = app.emit(
                                        "agent-config",
                                        json!({ "repo": repo, "chat": chat, "options": v["configOptions"] }),
                                    );
                                }
                            }
                        }
                        Op::Shutdown => break,
                    }
                }
                Ok(())
            })
            .await;

    crate::agent::client::cancel_all(&after_perms, &after_repo, &after_chat);
    match result {
        Err(e) => down(&after_app, &after_repo, &after_chat, gen, &format!("{e}")),
        Ok(()) => down(&after_app, &after_repo, &after_chat, gen, ""),
    }
}

/// The session is over, however it ended.
///
/// Stamped with the generation because this can arrive long after `stop` has
/// already said the same thing, and by then another session may be running —
/// an unstamped farewell is indistinguishable from news about that one.
fn down(app: &AppHandle, repo: &str, chat: &str, gen: u64, message: &str) {
    let _ = app.emit(
        "agent-down",
        json!({ "repo": repo, "chat": chat, "gen": gen, "message": message }),
    );
}
