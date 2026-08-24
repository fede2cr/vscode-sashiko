//! OpenAI chat-completions wire format, and its translation to the bridge protocol.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::protocol::{ChatMessage, ChatRequest, ToolCall, ToolDef, Usage};

#[derive(Debug, Deserialize)]
pub struct CompletionRequest {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub messages: Vec<RequestMessage>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub tools: Option<Vec<RequestTool>>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub response_format: Option<ResponseFormat>,
}

#[derive(Debug, Deserialize)]
pub struct ResponseFormat {
    #[serde(rename = "type", default)]
    pub kind: String,
}

#[derive(Debug, Deserialize)]
pub struct RequestMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<Content>,
    #[serde(default)]
    pub tool_calls: Option<Vec<RequestToolCall>>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

/// OpenAI accepts either a bare string or an array of typed content parts.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Deserialize)]
pub struct ContentPart {
    #[serde(default)]
    pub text: Option<String>,
}

impl Content {
    fn flatten(&self) -> String {
        match self {
            Content::Text(text) => text.clone(),
            Content::Parts(parts) => parts
                .iter()
                .filter_map(|part| part.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RequestToolCall {
    #[serde(default)]
    pub id: Option<String>,
    pub function: RequestFunctionCall,
}

#[derive(Debug, Deserialize)]
pub struct RequestFunctionCall {
    pub name: String,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RequestTool {
    pub function: RequestFunction,
}

#[derive(Debug, Deserialize)]
pub struct RequestFunction {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: Option<Value>,
}

impl CompletionRequest {
    pub fn into_chat_request(self) -> ChatRequest {
        let json_output = self
            .response_format
            .as_ref()
            .is_some_and(|format| format.kind.starts_with("json"));
        let messages = self
            .messages
            .into_iter()
            .map(|message| ChatMessage {
                role: message.role,
                content: message
                    .content
                    .as_ref()
                    .map(Content::flatten)
                    .unwrap_or_default(),
                tool_calls: message
                    .tool_calls
                    .unwrap_or_default()
                    .into_iter()
                    .enumerate()
                    .map(|(index, call)| ToolCall {
                        id: call.id.unwrap_or_else(|| format!("call_{index}")),
                        name: call.function.name,
                        arguments: call.function.arguments.unwrap_or_else(|| "{}".to_string()),
                    })
                    .collect(),
                tool_call_id: message.tool_call_id,
            })
            .collect();

        let tools = self
            .tools
            .unwrap_or_default()
            .into_iter()
            .map(|tool| ToolDef {
                name: tool.function.name,
                description: tool.function.description.unwrap_or_default(),
                input_schema: tool
                    .function
                    .parameters
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            })
            .collect();

        ChatRequest {
            model: self.model,
            messages,
            tools,
            temperature: self.temperature,
            json_output,
        }
    }
}

/// Recovers the JSON document from a response that a model wrapped in markdown fences
/// or prose. Sashiko parses these bodies strictly, and the VS Code chat API cannot
/// enforce `response_format`, so the unwrapping has to happen here.
pub fn unwrap_json_payload(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return trimmed.to_string();
    }

    let fenced = match trimmed.strip_prefix("```") {
        Some(rest) => {
            let body = rest.split_once('\n').map_or(rest, |(_, body)| body);
            body.rfind("```").map_or(body, |end| &body[..end])
        }
        None => trimmed,
    };

    match (fenced.find(['{', '[']), fenced.rfind(['}', ']'])) {
        (Some(start), Some(end)) if end > start => fenced[start..=end].trim().to_string(),
        _ => trimmed.to_string(),
    }
}

#[derive(Debug, Serialize)]
pub struct ResponseToolCall {
    pub index: usize,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: ResponseFunctionCall,
}

#[derive(Debug, Serialize)]
pub struct ResponseFunctionCall {
    pub name: String,
    pub arguments: String,
}

impl ResponseToolCall {
    pub fn new(index: usize, call: ToolCall) -> Self {
        Self {
            index,
            id: call.id,
            kind: "function",
            function: ResponseFunctionCall {
                name: call.name,
                arguments: call.arguments,
            },
        }
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

pub fn completion_body(
    id: &str,
    model: &str,
    text: String,
    calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: Usage,
) -> Value {
    let tool_calls: Vec<ResponseToolCall> = calls
        .into_iter()
        .enumerate()
        .map(|(index, call)| ResponseToolCall::new(index, call))
        .collect();
    let finish_reason = finish_reason.unwrap_or_else(|| {
        if tool_calls.is_empty() {
            "stop".to_string()
        } else {
            "tool_calls".to_string()
        }
    });

    let mut message = json!({ "role": "assistant", "content": text });
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }

    json!({
        "id": id,
        "object": "chat.completion",
        "created": now_secs(),
        "model": model,
        "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason }],
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total(),
        }
    })
}

pub fn chunk_body(id: &str, model: &str, delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": now_secs(),
        "model": model,
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
    })
}

pub fn error_body(message: &str, kind: &str) -> Value {
    json!({ "error": { "message": message, "type": kind, "code": kind } })
}

#[cfg(test)]
mod tests {
    use super::unwrap_json_payload;

    #[test]
    fn leaves_bare_json_alone() {
        assert_eq!(
            unwrap_json_payload("  {\"concerns\": []}\n"),
            "{\"concerns\": []}"
        );
    }

    #[test]
    fn strips_markdown_fences() {
        assert_eq!(
            unwrap_json_payload("```json\n{\"concerns\": []}\n```"),
            "{\"concerns\": []}"
        );
    }

    #[test]
    fn strips_surrounding_prose() {
        assert_eq!(
            unwrap_json_payload("Here is the result:\n{\"concerns\": []}\nHope that helps."),
            "{\"concerns\": []}"
        );
    }

    #[test]
    fn returns_input_when_there_is_no_json() {
        assert_eq!(unwrap_json_payload(" I cannot help. "), "I cannot help.");
    }
}
