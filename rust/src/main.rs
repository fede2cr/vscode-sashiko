//! Sashiko <-> VS Code language model bridge.
//!
//! `serve` exposes a loopback OpenAI-compatible endpoint that Sashiko's
//! `openai-compatible` provider consumes, and forwards every completion to the VS Code
//! extension host over stdio, where it is answered by `vscode.lm`. The remaining
//! subcommands keep configuration rendering and report parsing on the Rust side too.

mod bridge;
mod mcp;
mod openai;
mod prepare;
mod protocol;
mod review;
mod server;
mod settings;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "sashiko-vscode-bridge", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the OpenAI-compatible endpoint backed by the VS Code language model.
    Serve {
        /// TCP port to bind on 127.0.0.1; 0 picks a free port.
        #[arg(long, default_value_t = 0)]
        port: u16,
    },
    /// Render a Sashiko Settings.toml pointing at a running bridge.
    Settings(settings::SettingsArgs),
    /// Normalize a Sashiko JSON report into flat findings.
    ParseReview(review::ParseArgs),
    /// Stage patch files or uncommitted work as commits in a throwaway worktree.
    Prepare(prepare::PrepareArgs),
    /// Remove a worktree created by `prepare`.
    Cleanup(prepare::CleanupArgs),
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Serve { port } => serve(port),
        Command::Settings(args) => settings::run(&args),
        Command::ParseReview(args) => review::run(&args),
        Command::Prepare(args) => prepare::run(&args),
        Command::Cleanup(args) => prepare::cleanup(&args),
    }
}

#[tokio::main]
async fn serve(port: u16) -> Result<()> {
    // Two v4 UUIDs of CSPRNG entropy, shared with Sashiko as OPENAI_API_KEY.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let host = bridge::Host::spawn();
    server::serve(host, port, token).await
}
