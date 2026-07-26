use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::conversation::{CreateConvRequest, SessionMode};
use crate::mcp::registry::{Scope, Tool, ToolCtx};

#[derive(Deserialize, JsonSchema)]
pub struct Args {
    /// Stable, server-globally-unique name for the new chat session. AI
    /// callers use this as the addressing handle in subsequent tool calls
    /// (send_message, ask_question, introduce, …) instead of a UUID.
    /// Required and must not collide with any existing chat session.
    pub name: String,
    /// Optional human-readable display label shown in the UI; defaults to
    /// the cwd's basename. Free-form, non-unique, mutable via the update
    /// API. Distinct from `name` (which is the AI-facing addressing key).
    #[serde(default)]
    pub title: Option<String>,
    /// Working directory; defaults to neige's project_cwd.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Program to run; defaults to 'claude'.
    #[serde(default)]
    pub program: Option<String>,
    /// Optional HTTP/HTTPS proxy URL.
    #[serde(default)]
    pub proxy: Option<String>,
    /// If true and cwd is a git repo, run claude in a fresh git worktree. Default true.
    #[serde(default)]
    pub use_worktree: Option<bool>,
    /// Worktree branch suffix (claude --worktree <name>). Optional.
    #[serde(default)]
    pub worktree_name: Option<String>,
}

pub async fn handle(ctx: ToolCtx, args: Args) -> Result<Value, String> {
    let req = CreateConvRequest {
        title: args.title.unwrap_or_default(),
        program: args.program.unwrap_or_else(|| "claude".to_string()),
        cwd: args.cwd.unwrap_or_default(),
        proxy: args.proxy,
        // Default true mirrors CreateConvRequest::default_true on the
        // legacy REST shape — Option<bool> can't carry serde_default
        // semantics, so we resolve it here.
        use_worktree: args.use_worktree.unwrap_or(true),
        worktree_name: args.worktree_name,
        // MCP has no task surface yet, so sessions it creates are roots.
        parent_id: None,
        // MCP forces chat mode — there's no terminal client on the other
        // end of an MCP call. The Chat variant carries the addressing name.
        mode: SessionMode::Chat { name: args.name },
    };
    let mgr = ctx.manager();
    let mut guard = mgr.lock().await;
    let info = guard.create(req).await?;
    Ok(serde_json::to_value(info).unwrap_or(Value::Null))
}

pub fn tool() -> Tool {
    Tool::new(
        "create_session",
        "Create a new chat-mode neige session backed by a headless claude \
         subprocess. The required `name` is the AI-facing addressing handle \
         (used by send_message/ask_question/introduce); pick something short \
         and stable. `title` is an optional UI label. Returns the session \
         info; sessions persist across server restarts.",
        Scope::Global,
        handle,
    )
}
