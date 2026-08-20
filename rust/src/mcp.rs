//! Model Context Protocol server, served over Streamable HTTP by the bridge.
//!
//! Reusing the bridge's existing loopback listener keeps this to a single process:
//! VS Code is pointed at `/mcp` with the same bearer token Sashiko uses, and tool
//! calls travel back over the stdio link to the extension host, which owns the
//! workspace configuration and the Problems panel.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::bridge::Host;

/// Advertised when the client asks for a revision we do not recognise.
const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

const TOOL_NAMES: [&str; 3] = [
    "sashiko_review_range",
    "sashiko_review_patch",
    "sashiko_review_working_tree",
];

/// Tool catalogue. Every tool runs the full multi-stage Sashiko review, so the
/// descriptions steer the agent away from calling them for trivial questions.
fn tool_catalogue() -> Value {
    json!([
        {
            "name": TOOL_NAMES[0],
            "description": "Run a full Sashiko Linux kernel review over a git revision range in the \
                            user's kernel repository. Use this when the user asks to review commits \
                            that are already committed. Returns a severity-ranked finding summary; \
                            the complete findings also land in the VS Code Problems panel.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "range": {
                        "type": "string",
                        "description": "Git revision or range, such as 'HEAD', 'HEAD~3..HEAD' or a \
                                        commit SHA. Defaults to HEAD."
                    }
                }
            }
        },
        {
            "name": TOOL_NAMES[1],
            "description": "Run a full Sashiko Linux kernel review over one or more patch or mbox \
                            files. Use this for .patch/.mbox/.eml files the user has open or has \
                            downloaded from a mailing list. The patches are applied to a throwaway \
                            git worktree, reviewed, and the worktree is removed afterwards; the \
                            user's checkout is never modified.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Absolute paths to the patch files, in the order they should \
                                        be applied."
                    }
                },
                "required": ["paths"]
            }
        },
        {
            "name": TOOL_NAMES[2],
            "description": "Run a full Sashiko Linux kernel review over the uncommitted changes in \
                            the user's working tree. Use this when the user asks to review what \
                            they are currently working on. Tracked modifications are committed to a \
                            throwaway worktree for review; untracked files are not included.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

/// Handles one JSON-RPC message, returning `None` for notifications.
pub async fn handle(host: &Arc<Host>, request: Value) -> Option<Value> {
    // Notifications carry no id and must never be answered.
    let id = request.get("id").cloned()?;

    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return Some(failure(
            id,
            INVALID_REQUEST,
            "missing JSON-RPC method".into(),
        ));
    };
    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let outcome = match method {
        "initialize" => Ok(initialize(&params)),
        "tools/list" => Ok(json!({ "tools": tool_catalogue() })),
        "tools/call" => call_tool(host, &params).await,
        "ping" => Ok(json!({})),
        other => Err((METHOD_NOT_FOUND, format!("unknown method '{other}'"))),
    };

    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => failure(id, code, message),
    })
}

fn failure(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);
    let version = if SUPPORTED_VERSIONS.contains(&requested) {
        requested
    } else {
        PROTOCOL_VERSION
    };

    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "sashiko", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Sashiko reviews Linux kernel patches. A review runs many model requests \
                         and takes minutes, so call these tools only when the user explicitly asks \
                         for a kernel review."
    })
}

async fn call_tool(host: &Arc<Host>, params: &Value) -> Result<Value, (i64, String)> {
    let name = params.get("name").and_then(Value::as_str).ok_or_else(|| {
        (
            INVALID_PARAMS,
            "tools/call requires a tool name".to_string(),
        )
    })?;

    if !TOOL_NAMES.contains(&name) {
        return Err((INVALID_PARAMS, format!("unknown tool '{name}'")));
    }

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match host.call_tool(name, arguments).await {
        // A failed review is a tool error, not a protocol error, so the agent can react to it.
        Ok(outcome) => Ok(json!({
            "content": [{ "type": "text", "text": outcome.text }],
            "isError": outcome.is_error
        })),
        Err(err) => Err((INTERNAL_ERROR, err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_every_tool_with_a_schema() {
        let catalogue = tool_catalogue();
        let tools = catalogue.as_array().expect("catalogue is an array");
        assert_eq!(tools.len(), TOOL_NAMES.len());
        for tool in tools {
            assert!(TOOL_NAMES.contains(&tool["name"].as_str().unwrap()));
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn echoes_a_supported_protocol_version() {
        let result = initialize(&json!({ "protocolVersion": "2025-03-26" }));
        assert_eq!(result["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn falls_back_for_unknown_protocol_versions() {
        let result = initialize(&json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
    }
}
