//! Turning a `session/update` into something the panel can draw.
//!
//! Mapped from JSON rather than from the SDK's Rust enums, deliberately. The
//! wire shape is the part of ACP that is specified and stable; the enums are
//! one library's rendering of it and gain variants between releases. Reading
//! the JSON means an unknown update is ignored instead of failing to compile,
//! and it means this file can be tested with literal notifications — which is
//! the test that catches an SDK bump, so it had better not need one.

use serde_json::{json, Value};

/// A Tauri event to emit: its name, and its payload.
pub struct Emit {
    pub name: &'static str,
    pub payload: Value,
}

/// Text out of a content block, whatever shape it arrived in.
fn text_of(v: &Value) -> String {
    if let Some(t) = v["text"].as_str() {
        return t.to_string();
    }
    // A chunk may carry `content: {type:"text", text}` instead of the text
    // directly; both are legal and agents differ.
    v["content"]["text"].as_str().unwrap_or("").to_string()
}

/// Map one update. `None` for anything we have no place to put yet — an
/// unknown update is not an error, it is a feature we have not built.
pub fn map(repo: &str, turn: u64, u: &Value) -> Option<Emit> {
    let kind = u["sessionUpdate"].as_str()?;
    match kind {
        "agent_message_chunk" => Some(Emit {
            name: "agent-message",
            payload: json!({ "repo": repo, "turn": turn, "text": text_of(u) }),
        }),
        "agent_thought_chunk" => Some(Emit {
            name: "agent-thought",
            payload: json!({ "repo": repo, "turn": turn, "text": text_of(u) }),
        }),
        /*
         * A tool call and its updates share `toolCallId`, and the panel
         * upserts on it. Both are the same event on purpose: the first
         * carries a title, later ones carry status and locations, and a UI
         * that had to tell them apart would be encoding the order the agent
         * happened to send them in.
         */
        "tool_call" | "tool_call_update" => {
            let id = u["toolCallId"].as_str()?;
            Some(Emit {
                name: "agent-tool",
                payload: json!({
                    "repo": repo,
                    "turn": turn,
                    "callId": id,
                    "title": u["title"].as_str(),
                    "kind": u["kind"].as_str(),
                    "status": u["status"].as_str(),
                    "locations": u["locations"].as_array().map(|l| {
                        l.iter()
                            .filter_map(|x| x["path"].as_str())
                            .map(|p| p.rsplit('/').next().unwrap_or(p).to_string())
                            .collect::<Vec<_>>()
                    }),
                }),
            })
        }
        "plan" => Some(Emit {
            name: "agent-plan",
            payload: json!({ "repo": repo, "entries": u["entries"] }),
        }),
        "available_commands_update" => Some(Emit {
            name: "agent-commands",
            payload: json!({ "repo": repo, "commands": u["availableCommands"] }),
        }),
        "config_option_update" => Some(Emit {
            name: "agent-config",
            payload: json!({ "repo": repo, "options": u["configOptions"] }),
        }),
        // Context spent and what it cost, which the agent volunteers and no
        // other surface in the app can tell you.
        "usage_update" => Some(Emit {
            name: "agent-usage",
            payload: json!({
                "repo": repo,
                "used": u["used"],
                "size": u["size"],
                "cost": u["cost"]["amount"],
            }),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The literal shapes observed from `@agentclientprotocol/claude-agent-acp`.
    /// If an SDK or adapter bump changes them, these fail — which is the job.
    #[test]
    fn prose_becomes_a_message() {
        let u = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "Hello" },
            "messageId": "msg_1"
        });
        let e = map("/r", 7, &u).unwrap();
        assert_eq!(e.name, "agent-message");
        assert_eq!(e.payload["text"], "Hello");
        assert_eq!(e.payload["turn"], 7);
        assert_eq!(e.payload["repo"], "/r");
    }

    #[test]
    fn reasoning_is_its_own_channel() {
        let u = json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": "thinking" }
        });
        assert_eq!(map("/r", 1, &u).unwrap().name, "agent-thought");
    }

    #[test]
    fn a_tool_call_and_its_update_are_one_event_keyed_by_id() {
        let start = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "toolu_1",
            "title": "Read File",
            "kind": "read"
        });
        let done = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "toolu_1",
            "title": "Read note.md",
            "status": "completed",
            "locations": [{ "path": "/a/b/note.md", "line": 1 }]
        });
        let a = map("/r", 1, &start).unwrap();
        let b = map("/r", 1, &done).unwrap();
        assert_eq!(a.name, b.name);
        assert_eq!(a.payload["callId"], b.payload["callId"]);
        // The agent writes the title; we no longer guess it from tool inputs.
        assert_eq!(b.payload["title"], "Read note.md");
        assert_eq!(b.payload["status"], "completed");
        assert_eq!(b.payload["locations"][0], "note.md");
    }

    #[test]
    fn commands_and_config_come_through_whole() {
        let cmds = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [{ "name": "web", "description": "Search" }]
        });
        assert_eq!(
            map("/r", 1, &cmds).unwrap().payload["commands"][0]["name"],
            "web"
        );

        let cfg = json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "model", "category": "model", "type": "select",
                "currentValue": "fable",
                "options": [{ "value": "fable", "name": "Fable" }]
            }]
        });
        let e = map("/r", 1, &cfg).unwrap();
        assert_eq!(e.name, "agent-config");
        assert_eq!(e.payload["options"][0]["currentValue"], "fable");
    }

    #[test]
    fn usage_carries_context_and_cost() {
        let u = json!({
            "sessionUpdate": "usage_update",
            "used": 27564, "size": 1000000,
            "cost": { "amount": 0.2811, "currency": "USD" }
        });
        let e = map("/r", 1, &u).unwrap();
        assert_eq!(e.payload["used"], 27564);
        assert_eq!(e.payload["cost"], 0.2811);
    }

    #[test]
    fn an_update_we_have_no_place_for_is_ignored_not_fatal() {
        // Agents send more than we draw, and will send more still. Silence is
        // the correct response to a feature we have not built.
        let u = json!({ "sessionUpdate": "session_info_update", "title": "x" });
        assert!(map("/r", 1, &u).is_none());
        assert!(map("/r", 1, &json!({ "nothing": true })).is_none());
    }
}
