//! Wire types shared between the bridge process and the VS Code extension host.
//!
//! The two processes talk newline-delimited JSON over the child process' stdio:
//! the bridge owns stdout, the extension host owns stdin.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Messages sent from the bridge to the VS Code extension host.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostBound {
    /// Emitted once the HTTP listener is bound; carries the credentials Sashiko must use.
    Ready { port: u16, token: String },
    /// A chat completion that must be answered by `vscode.lm`.
    Request {
        id: String,
        #[serde(flatten)]
        payload: ChatRequest,
    },
    /// The HTTP client went away; the extension host should abort the request.
    Cancel { id: String },
    /// An MCP tool invocation the extension host must execute.
    Tool {
        id: String,
        name: String,
        arguments: Value,
    },
    Log {
        level: &'static str,
        message: String,
    },
}

/// Messages sent from the VS Code extension host to the bridge.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionBound {
    /// The catalogue of chat models the user has available, used by `GET /v1/models`.
    Models {
        models: Vec<ModelInfo>,
    },
    Chunk {
        id: String,
        delta: String,
    },
    ToolCall {
        id: String,
        call: ToolCall,
    },
    Done {
        id: String,
        #[serde(default)]
        finish_reason: Option<String>,
        #[serde(default)]
        usage: Option<Usage>,
    },
    Error {
        id: String,
        message: String,
    },
    /// The outcome of a `Tool` invocation, rendered for the MCP client.
    ToolResult {
        id: String,
        text: String,
        #[serde(default)]
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// The caller asked for `response_format: json_object`; the VS Code chat API has no
    /// JSON mode, so the extension host has to ask for it in the prompt instead.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub json_output: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// `system`, `user`, `assistant` or `tool`.
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON-encoded argument object, matching the OpenAI wire format.
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.prompt_tokens + self.completion_tokens
    }
}

/// Rough token count used for Sashiko's budget caps; the VS Code API exposes no
/// per-request usage, and its tokenizer is too slow to run over 100k-token prompts.
pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

impl ChatRequest {
    pub fn estimated_prompt_tokens(&self) -> u64 {
        self.messages
            .iter()
            .map(|message| estimate_tokens(&message.content))
            .sum()
    }
}
