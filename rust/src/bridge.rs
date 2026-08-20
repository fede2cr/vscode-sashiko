//! Duplex link to the VS Code extension host over the process' stdio.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::protocol::{ChatRequest, ExtensionBound, HostBound, ModelInfo, ToolCall, Usage};

/// A single piece of a streamed completion.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Text(String),
    ToolCall(ToolCall),
    Done {
        finish_reason: Option<String>,
        usage: Option<Usage>,
    },
    Error(String),
}

/// What the extension host made of an MCP tool invocation.
#[derive(Debug, Clone)]
pub struct ToolOutcome {
    pub text: String,
    pub is_error: bool,
}

#[derive(Default)]
struct State {
    pending: HashMap<String, mpsc::UnboundedSender<StreamEvent>>,
    tools: HashMap<String, oneshot::Sender<ToolOutcome>>,
    models: Vec<ModelInfo>,
}

pub struct Host {
    outbox: mpsc::UnboundedSender<String>,
    state: Mutex<State>,
}

impl Host {
    /// Spawns the stdout writer and stdin reader tasks and returns the link.
    pub fn spawn() -> Arc<Self> {
        let (outbox, mut rx) = mpsc::unbounded_channel::<String>();
        let host = Arc::new(Self {
            outbox,
            state: Mutex::new(State::default()),
        });

        tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(line) = rx.recv().await {
                if stdout.write_all(line.as_bytes()).await.is_err()
                    || stdout.write_all(b"\n").await.is_err()
                    || stdout.flush().await.is_err()
                {
                    break;
                }
            }
        });

        let reader_host = Arc::clone(&host);
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<ExtensionBound>(line) {
                    Ok(message) => reader_host.dispatch(message),
                    Err(err) => reader_host.log("warn", format!("unparsable host message: {err}")),
                }
            }
            // stdin closed: the extension host is gone, so is our reason to live.
            reader_host.fail_all("extension host disconnected");
            std::process::exit(0);
        });

        host
    }

    fn dispatch(&self, message: ExtensionBound) {
        match message {
            ExtensionBound::Models { models } => {
                self.state.lock().unwrap().models = models;
            }
            ExtensionBound::Chunk { id, delta } => self.emit(&id, StreamEvent::Text(delta), false),
            ExtensionBound::ToolCall { id, call } => {
                self.emit(&id, StreamEvent::ToolCall(call), false)
            }
            ExtensionBound::Done {
                id,
                finish_reason,
                usage,
            } => self.emit(
                &id,
                StreamEvent::Done {
                    finish_reason,
                    usage,
                },
                true,
            ),
            ExtensionBound::Error { id, message } => {
                self.emit(&id, StreamEvent::Error(message), true)
            }
            ExtensionBound::ToolResult { id, text, is_error } => {
                let sender = self.state.lock().unwrap().tools.remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(ToolOutcome { text, is_error });
                }
            }
        }
    }

    fn emit(&self, id: &str, event: StreamEvent, terminal: bool) {
        let mut state = self.state.lock().unwrap();
        let sender = if terminal {
            state.pending.remove(id)
        } else {
            state.pending.get(id).cloned()
        };
        drop(state);
        if let Some(sender) = sender {
            let _ = sender.send(event);
        }
    }

    fn fail_all(&self, reason: &str) {
        let mut state = self.state.lock().unwrap();
        let pending = std::mem::take(&mut state.pending);
        // Dropping the oneshot senders makes every awaiting tool call resolve as an error.
        state.tools.clear();
        drop(state);
        for (_, sender) in pending {
            let _ = sender.send(StreamEvent::Error(reason.to_string()));
        }
    }

    fn send(&self, message: HostBound) {
        match serde_json::to_string(&message) {
            Ok(line) => {
                let _ = self.outbox.send(line);
            }
            Err(err) => eprintln!("failed to encode host message: {err}"),
        }
    }

    pub fn log(&self, level: &'static str, message: impl Into<String>) {
        self.send(HostBound::Log {
            level,
            message: message.into(),
        });
    }

    pub fn announce_ready(&self, port: u16, token: &str) {
        self.send(HostBound::Ready {
            port,
            token: token.to_string(),
        });
    }

    pub fn models(&self) -> Vec<ModelInfo> {
        self.state.lock().unwrap().models.clone()
    }

    /// Forwards a completion request to the extension host and returns its event stream.
    pub fn request(self: &Arc<Self>, payload: ChatRequest) -> ResponseStream {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        self.state.lock().unwrap().pending.insert(id.clone(), tx);
        self.send(HostBound::Request {
            id: id.clone(),
            payload,
        });
        ResponseStream {
            host: Arc::clone(self),
            id,
            rx,
            finished: false,
        }
    }

    /// Hands an MCP tool invocation to the extension host and waits for its verdict.
    ///
    /// The tools operate on workspace configuration and the Problems panel, so the
    /// extension host is the only process that can run them.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolOutcome> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.state.lock().unwrap().tools.insert(id.clone(), tx);
        self.send(HostBound::Tool {
            id,
            name: name.to_string(),
            arguments,
        });
        rx.await
            .map_err(|_| anyhow!("the VS Code extension host did not answer the tool call"))
    }
}

/// Stream of events for one in-flight completion.
///
/// Dropping it before completion cancels the request in the extension host, which
/// is what makes HTTP client disconnects propagate all the way to `vscode.lm`.
pub struct ResponseStream {
    host: Arc<Host>,
    id: String,
    rx: mpsc::UnboundedReceiver<StreamEvent>,
    finished: bool,
}

impl ResponseStream {
    pub async fn recv(&mut self) -> Option<StreamEvent> {
        let event = self.rx.recv().await;
        if matches!(
            event,
            None | Some(StreamEvent::Done { .. }) | Some(StreamEvent::Error(_))
        ) {
            self.finished = true;
        }
        event
    }

    /// Drains the stream into a single response body.
    pub async fn collect(mut self) -> Result<(String, Vec<ToolCall>, Option<String>, Usage)> {
        let mut text = String::new();
        let mut calls = Vec::new();
        loop {
            match self.recv().await {
                Some(StreamEvent::Text(delta)) => text.push_str(&delta),
                Some(StreamEvent::ToolCall(call)) => calls.push(call),
                Some(StreamEvent::Done {
                    finish_reason,
                    usage,
                }) => return Ok((text, calls, finish_reason, usage.unwrap_or_default())),
                Some(StreamEvent::Error(message)) => return Err(anyhow!(message)),
                None => return Err(anyhow!("language model stream closed unexpectedly")),
            }
        }
    }
}

impl Drop for ResponseStream {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.host.state.lock().unwrap().pending.remove(&self.id);
        self.host.send(HostBound::Cancel {
            id: self.id.clone(),
        });
    }
}
