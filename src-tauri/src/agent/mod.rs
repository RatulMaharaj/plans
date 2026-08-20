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

/*
 * Turn ids stay globally unique, deliberately.
 *
 * There was a `CURRENT_TURN` global here as well, holding the turn a
 * notification belonged to. One at a time per session made a single value
 * enough — and stopped being true the moment two sessions could run, at which
 * point it stamped one chat's narration with the other chat's turn. The value
 * now lives in the session that owns it; only the counter is shared, so no two
 * sessions can ever mint the same number.
 */
static NEXT_TURN: AtomicU64 = AtomicU64::new(1);

/// Which session an event is about.
///
/// `agent-down` is emitted twice for one stop, and has to be: `stop` says so
/// at once, so the panel is not left waiting on a process that is already
/// unreachable, and the session's own task says so again when it has actually
/// finished — which is arbitrarily later, because telling a session to stop
/// only queues the message.
///
/// With nothing to tell the two apart, that second one is indistinguishable
/// from news about whatever is running *now*. Stop a session, start another,
/// and the first one's farewell arrives to clear the second one's turn — after
/// which the running agent's answer goes nowhere, which looks exactly like an
/// agent that has nothing to say.
///
/// So every session carries a number, and every event that could outlive its
/// session carries it too. A message about a session older than the one in
/// hand is a message about something already over.
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

struct Live {
    ops: UnboundedSender<session::Op>,
    perms: client::Pending,
    /// Which agent this session is. Changing the setting has to end it.
    agent: String,
    /// Which session this is, among all the ones this key has had.
    gen: u64,
}

/**
 * A session per conversation, not per repository.
 *
 * Keyed by repository alone, there was one session by construction — which is
 * why two agents could not run at once, and why changing chat had to *end* the
 * running one: the single session could not be having two conversations, so
 * moving to another meant killing what was there. A chat is what a session
 * actually is, so it is what a session is keyed by.
 *
 * The repository stays in the key because a chat id is only unique within one
 * (`chats.ts`), and because everything a session does — the working directory
 * it is started in, the plans it is about — is that repository's.
 */
type Key = (String, String);

fn key(repo: &str, chat: &str) -> Key {
    (repo.to_string(), chat.to_string())
}

#[derive(Default)]
pub struct Agents(Mutex<HashMap<Key, Live>>);

/// Start a session for `repo` if there is not one already.
///
/// Lazily, on the first thing anyone says — booting an agent process for
/// someone who opens the panel and then closes it again is rude, and the
/// handshake can prompt for authentication.
fn ensure(
    app: &AppHandle,
    repo: &str,
    chat: &str,
    agent_id: &str,
    resume: Option<String>,
) -> R<()> {
    let state: State<Agents> = app.state();
    /*
     * A live session is reused — unless it is the wrong agent.
     *
     * Choosing a different agent in settings has to actually change which
     * process answers, and the running one has no way to become the other
     * one. So it is ended here, at the first thing said after the change,
     * rather than eagerly when the setting moves: someone flicking through
     * the list should not be killing processes as they go.
     */
    let stale = {
        let live = state.0.lock().unwrap();
        live.get(&key(repo, chat)).map(|l| l.agent != agent_id)
    };
    match stale {
        Some(false) => return Ok(()),
        // Only this conversation. A sibling chat running the old agent is
        // still having a coherent conversation with it, and ending that
        // because a setting moved would be answering a question nobody asked.
        Some(true) => stop(app, repo, chat),
        None => {}
    }
    let argv = discover::argv_for(agent_id).ok_or_else(|| {
        format!("{agent_id} is not installed, or not on the PATH this app was given")
    })?;

    let (tx, rx) = unbounded_channel();
    let perms = client::pending();
    let gen = NEXT_GEN.fetch_add(1, Ordering::Relaxed);
    state.0.lock().unwrap().insert(
        key(repo, chat),
        Live {
            ops: tx,
            perms: perms.clone(),
            agent: agent_id.to_string(),
            gen,
        },
    );

    let (a, r, c) = (app.clone(), repo.to_string(), chat.to_string());
    tauri::async_runtime::spawn(async move {
        session::run(
            a.clone(),
            r.clone(),
            c.clone(),
            gen,
            argv,
            resume,
            rx,
            perms,
        )
        .await;
        /*
         * However it ended, it is no longer live — but only if it is still the
         * session in the map. A stop followed by a fresh prompt puts a *new*
         * session under the same key before this task has finished winding
         * down, and removing then would evict a live session on the strength
         * of a dead one's cleanup.
         */
        if let Some(s) = a.try_state::<Agents>() {
            let mut live = s.0.lock().unwrap();
            if live.get(&key(&r, &c)).is_some_and(|l| l.gen == gen) {
                live.remove(&key(&r, &c));
            }
        }
    });
    Ok(())
}

fn send(app: &AppHandle, repo: &str, chat: &str, op: session::Op) -> R<()> {
    let state: State<Agents> = app.state();
    let live = state.0.lock().unwrap();
    // "for this chat", not "for this repository": a sibling chat in the same
    // repository may well be running, so the old wording would now mislead.
    let l = live
        .get(&key(repo, chat))
        .ok_or("no agent is running for this chat")?;
    l.ops
        .send(op)
        .map_err(|_| "the agent has stopped".to_string())
}

/// Say something. Starts the session if this is the first thing said.
///
/// Every command here takes `chat` as one word on purpose. Tauri maps a
/// camelCase key from JavaScript onto a snake_case parameter, so a `chat_id`
/// would have to be sent as `chatId` — a conversion worth not having when the
/// name needs none.
#[tauri::command]
pub fn agent_prompt(
    app: AppHandle,
    repo: String,
    chat: String,
    agent: String,
    text: String,
    resume: Option<String>,
) -> R<u64> {
    ensure(&app, &repo, &chat, &agent, resume)?;
    let turn = NEXT_TURN.fetch_add(1, Ordering::Relaxed);
    send(&app, &repo, &chat, session::Op::Prompt { turn, text })?;
    Ok(turn)
}

#[tauri::command]
pub fn agent_cancel(app: AppHandle, repo: String, chat: String, turn: u64) -> R<()> {
    send(&app, &repo, &chat, session::Op::Cancel { turn })
}

#[tauri::command]
pub fn agent_set_config(
    app: AppHandle,
    repo: String,
    chat: String,
    id: String,
    value: String,
) -> R<()> {
    send(&app, &repo, &chat, session::Op::SetConfig { id, value })
}

/// Answer a permission request. `option` of `None` means "cancelled".
#[tauri::command]
pub fn agent_permission(
    app: AppHandle,
    repo: String,
    chat: String,
    request_id: String,
    option: Option<String>,
) -> R<()> {
    let state: State<Agents> = app.state();
    let live = state.0.lock().unwrap();
    if let Some(l) = live.get(&key(&repo, &chat)) {
        client::answer(&l.perms, &request_id, option);
    }
    Ok(())
}

/// End one conversation's session, if there is one.
fn stop(app: &AppHandle, repo: &str, chat: &str) {
    let state: State<Agents> = app.state();
    let live = state.0.lock().unwrap().remove(&key(repo, chat));
    // The generation of whatever was stopped. Nothing running is generation 0,
    // which is older than every real session and so is ignored by nothing —
    // there was no turn in flight for it to have cleared anyway.
    let gen = live.as_ref().map(|l| l.gen).unwrap_or(0);
    if let Some(l) = live {
        client::cancel_all(&l.perms, repo, chat);
        let _ = l.ops.send(session::Op::Shutdown);
    }
    let _ = app.emit(
        "agent-down",
        json!({ "repo": repo, "chat": chat, "gen": gen, "message": "" }),
    );
}

/// Stop one conversation's agent.
///
/// What ends a session is deleting the conversation, clearing it, or quitting.
/// Moving between chats no longer does: that was only ever a consequence of
/// there being one session per repository, and it is why setting an agent going
/// and then reading another conversation could not be done.
#[tauri::command]
pub fn agent_stop(app: AppHandle, repo: String, chat: String) -> R<()> {
    stop(&app, &repo, &chat);
    Ok(())
}

/// Shut every session down, and wait for it.
///
/// Called on quit. The old design's children lived for one turn and cleaned
/// themselves up; these live as long as the window, and a `node` per
/// repository left behind after the app closes is the regression this exists
/// to prevent.
///
/// The waiting is the point. Telling a session to stop only queues the
/// message: the task that reads it has to be scheduled, the connection has to
/// drop, and only then does the SDK kill the agent's process group. If this
/// returned immediately the process would exit first, the children would
/// re-parent to init, and quitting the app would quietly leave an agent
/// running. So the main thread blocks — briefly, and with a ceiling, because
/// a quit that hangs is worse than a stray process.
pub fn shutdown_all(app: &AppHandle) {
    let Some(state) = app.try_state::<Agents>() else {
        return;
    };
    /*
     * Told, not removed.
     *
     * Each session takes itself out of the map when its task finishes, and
     * that is the signal being waited for — draining here would empty the map
     * before anything had actually stopped, and the wait below would pass
     * instantly while the agents carried on.
     */
    {
        let live = state.0.lock().unwrap();
        if live.is_empty() {
            return;
        }
        for ((repo, chat), l) in live.iter() {
            client::cancel_all(&l.perms, repo, chat);
            let _ = l.ops.send(session::Op::Shutdown);
        }
    }
    // The ceiling is a budget for all of them together, not one each: with
    // several sessions a per-session allowance would turn quitting into a
    // hang, and a quit that hangs is worse than a stray process.
    let started = std::time::Instant::now();
    loop {
        if state.0.lock().unwrap().is_empty() {
            return;
        }
        if started.elapsed() > std::time::Duration::from_secs(2) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
