use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp::registry::{Scope, Tool, ToolCtx};

#[derive(Deserialize, JsonSchema)]
pub struct Args {
    /// Chat session to delete, by `name`. Terminal sessions are deleted
    /// via the REST `DELETE /api/conversations/{uuid}` route — they don't
    /// have names and aren't intended to be addressed by AI tools.
    pub session: String,
}

pub async fn handle(ctx: ToolCtx, args: Args) -> Result<Value, String> {
    let target = ctx.resolve_chat_session(&args.session).await?;
    let mgr = ctx.manager();
    let mut guard = mgr.lock().await;
    guard.remove(&target).await;
    Ok(json!({"deleted": target, "name": args.session}))
}

pub fn tool() -> Tool {
    Tool::new(
        "delete_session",
        "Permanently delete a chat session by `name`: kills its daemon (and \
         the claude subprocess) and removes its metadata file. Any agents \
         nested under this session are deleted along with it. Irreversible. \
         Use `stop` instead to just interrupt a turn.",
        Scope::Global,
        handle,
    )
}
