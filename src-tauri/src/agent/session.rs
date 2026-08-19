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
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionConfigOptionValue,
    SessionNotification, SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use serde_json::json;
use std::str::FromStr;
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
    argv: Vec<String>,
    mut ops: UnboundedReceiver<Op>,
    perms: crate::agent::client::Pending,
) {
    let line = argv.join(" ");
    let agent = match AcpAgent::from_str(&line) {
        Ok(a) => a,
        Err(e) => return down(&app, &repo, &format!("could not start the agent: {e}")),
    };

    let (r2, a2) = (repo.clone(), app.clone());
    let (r3, a3, p3) = (repo.clone(), app.clone(), perms.clone());
    // The connection closure takes ownership; these are what is left to report
    // with once it has finished, whichever way it finished.
    let (after_app, after_repo, after_perms) = (app.clone(), repo.clone(), perms.clone());

    let result =
        agent_client_protocol::Client
            .builder()
            .on_receive_notification(
                move |n: SessionNotification, _cx| {
                    let (app, repo) = (a2.clone(), r2.clone());
                    async move {
                        let raw = serde_json::to_value(&n.update).unwrap_or(json!({}));
                        let t =
                            crate::agent::CURRENT_TURN.load(std::sync::atomic::Ordering::Relaxed);
                        if let Some(e) = events::map(&repo, t, &raw) {
                            let _ = app.emit(e.name, e.payload);
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                move |req, responder, _c| {
                    let (app, repo, pending) = (a3.clone(), r3.clone(), p3.clone());
                    async move {
                        crate::agent::client::permission(app, repo, pending, req, responder).await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, |c: ConnectionTo<Agent>| async move {
                c.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                let opened = c
                    .send_request(NewSessionRequest::new(std::path::PathBuf::from(&repo)))
                    .block_task()
                    .await?;

                // What the agent can do is news the moment it is known: the
                // pickers and the slash list are drawn from this, before anyone
                // has said anything.
                if let Ok(v) = serde_json::to_value(&opened) {
                    if !v["configOptions"].is_null() {
                        let _ = app.emit(
                            "agent-config",
                            json!({ "repo": repo, "options": v["configOptions"] }),
                        );
                    }
                }
                let _ = app.emit("agent-ready", json!({ "repo": repo }));

                let sid = opened.session_id;
                while let Some(op) = ops.recv().await {
                    match op {
                        Op::Prompt { turn, text } => {
                            crate::agent::CURRENT_TURN
                                .store(turn, std::sync::atomic::Ordering::Relaxed);
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
                            json!({ "repo": repo, "turn": turn, "stop": stop, "ok": out.is_ok() }),
                        );
                        }
                        Op::Cancel { turn } => {
                            /*
                             * Answer every outstanding permission before asking
                             * the agent to stop. It is blocked on us; if we go
                             * quiet it waits forever and the session is wedged
                             * with no way back short of killing the process.
                             */
                            crate::agent::client::cancel_all(&perms, &repo);
                            let _ = app.emit(
                            "agent-turn",
                            json!({ "repo": repo, "turn": turn, "stop": "cancelled", "ok": false }),
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
                                        json!({ "repo": repo, "options": v["configOptions"] }),
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

    crate::agent::client::cancel_all(&after_perms, &after_repo);
    match result {
        Err(e) => down(&after_app, &after_repo, &format!("{e}")),
        Ok(()) => down(&after_app, &after_repo, ""),
    }
}

/// The session is over, however it ended.
fn down(app: &AppHandle, repo: &str, message: &str) {
    let _ = app.emit("agent-down", json!({ "repo": repo, "message": message }));
}
