//! OpenAI-compatible HTTP surface that Sashiko's `openai-compatible` provider talks to.

use std::convert::Infallible;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::bridge::{Host, StreamEvent};
use crate::mcp;
use crate::openai::{
    chunk_body, completion_body, error_body, now_secs, CompletionRequest, ResponseToolCall,
};
use crate::protocol::{estimate_tokens, Usage};

/// Kernel review prompts routinely exceed axum's 2 MiB default.
const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;

struct AppState {
    host: Arc<Host>,
    token: String,
}

pub async fn serve(host: Arc<Host>, port: u16, token: String) -> Result<()> {
    let state = Arc::new(AppState {
        host: Arc::clone(&host),
        token,
    });

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/mcp", post(mcp_endpoint))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Arc::clone(&state));

    // Loopback only: the endpoint is an unauthenticated proxy to the user's paid model
    // quota, so it must never be reachable from outside this machine.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let bound = listener.local_addr()?.port();
    host.announce_ready(bound, &state.token);
    axum::serve(listener, app).await?;
    Ok(())
}

/// Length-independent comparison so the bearer token cannot be recovered by timing.
fn token_matches(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .bytes()
        .zip(provided.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Returns the rejection response when the bearer token is missing or wrong.
fn reject_unauthorized(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();

    if token_matches(&state.token, provided) {
        return None;
    }
    Some(
        (
            StatusCode::UNAUTHORIZED,
            Json(error_body("invalid bridge token", "invalid_api_key")),
        )
            .into_response(),
    )
}

/// Streamable HTTP transport for the MCP server; VS Code POSTs JSON-RPC here.
async fn mcp_endpoint(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Some(response) = reject_unauthorized(&state, &headers) {
        return response;
    }

    let request: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(err) => return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("malformed JSON-RPC payload: {err}") }
            })),
        )
            .into_response(),
    };

    match mcp::handle(&state.host, request).await {
        Some(response) => Json(response).into_response(),
        // Notifications get an acknowledgement with no body, per the transport spec.
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn list_models(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = reject_unauthorized(&state, &headers) {
        return response;
    }

    let data: Vec<Value> = state
        .host
        .models()
        .into_iter()
        .map(|model| {
            json!({
                "id": model.id,
                "object": "model",
                "created": now_secs(),
                "owned_by": if model.vendor.is_empty() { "vscode".to_string() } else { model.vendor },
            })
        })
        .collect();

    Json(json!({ "object": "list", "data": data })).into_response()
}

async fn chat_completions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Some(response) = reject_unauthorized(&state, &headers) {
        return response;
    }

    let request: CompletionRequest = match serde_json::from_str(&body) {
        Ok(request) => request,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(error_body(
                    &format!("malformed chat completion request: {err}"),
                    "invalid_request_error",
                )),
            )
                .into_response()
        }
    };

    let streaming = request.stream;
    let chat = request.into_chat_request();
    let model = chat
        .model
        .clone()
        .unwrap_or_else(|| "vscode-lm".to_string());
    let prompt_tokens = chat.estimated_prompt_tokens();
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4());
    let stream = state.host.request(chat);

    if !streaming {
        return match stream.collect().await {
            Ok((text, calls, finish_reason, mut usage)) => {
                if usage.total() == 0 {
                    usage = Usage {
                        prompt_tokens,
                        completion_tokens: estimate_tokens(&text),
                    };
                }
                Json(completion_body(
                    &id,
                    &model,
                    text,
                    calls,
                    finish_reason,
                    usage,
                ))
                .into_response()
            }
            Err(err) => (
                StatusCode::BAD_GATEWAY,
                Json(error_body(&err.to_string(), "upstream_error")),
            )
                .into_response(),
        };
    }

    let sse = async_stream::stream! {
        let mut stream = stream;
        let mut tool_index = 0usize;
        let mut sent_role = false;

        loop {
            match stream.recv().await {
                Some(StreamEvent::Text(delta)) => {
                    let mut payload = json!({ "content": delta });
                    if !sent_role {
                        payload["role"] = json!("assistant");
                        sent_role = true;
                    }
                    yield Ok::<Event, Infallible>(
                        Event::default().data(chunk_body(&id, &model, payload, None).to_string()),
                    );
                }
                Some(StreamEvent::ToolCall(call)) => {
                    let payload = json!({
                        "tool_calls": [ResponseToolCall::new(tool_index, call)],
                    });
                    tool_index += 1;
                    yield Ok(Event::default()
                        .data(chunk_body(&id, &model, payload, None).to_string()));
                }
                Some(StreamEvent::Done { finish_reason, .. }) => {
                    let reason = finish_reason.unwrap_or_else(|| {
                        if tool_index > 0 { "tool_calls".to_string() } else { "stop".to_string() }
                    });
                    yield Ok(Event::default()
                        .data(chunk_body(&id, &model, json!({}), Some(&reason)).to_string()));
                    yield Ok(Event::default().data("[DONE]"));
                    break;
                }
                Some(StreamEvent::Error(message)) => {
                    yield Ok(Event::default()
                        .data(error_body(&message, "upstream_error").to_string()));
                    yield Ok(Event::default().data("[DONE]"));
                    break;
                }
                None => break,
            }
        }
    };

    Sse::new(sse)
        .keep_alive(KeepAlive::default())
        .into_response()
}
