//! Tool registry primitives.
//!
//! Each MCP tool is one file under `mcp/tools/`. That file defines an `Args`
//! type (`#[derive(Deserialize, JsonSchema)]`), an async handler taking
//! `(ToolCtx, Args)`, and a single `pub fn tool() -> Tool` exporting the
//! registration. `mcp/tools/mod.rs` collects them all into Scope-keyed sets.
//!
//! ## Why this shape
//!
//! - **schemars** derives `inputSchema` from `Args`, so the JSON schema can
//!   never drift from the Rust types.
//! - **`Scope`** decides which routes a tool appears on (Global / Targeted /
//!   SelfScoped). The route handler in `mcp/mod.rs` consults Scope; tool
//!   files don't have to know about routing.
//! - **`ToolCtx`** wraps `(AppState, Option<Uuid>)`. Tool handlers grab
//!   what they need (`ctx.manager()`, `ctx.session_id_required()`) instead
//!   of accepting a tuple of weakly-typed args.

use std::future::Future;
use std::pin::Pin;

use schemars::{JsonSchema, schema_for};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use uuid::Uuid;

use super::protocol::ToolDescriptor;
use crate::api::AppState;
use crate::conversation::SharedManager;

/// Routing scope for a tool. Determines which URL prefixes surface it and
/// whether `ToolCtx::session_id_required()` is guaranteed to succeed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Visible at `/mcp` AND `/mcp/{id}`. Doesn't depend on a URL session
    /// id (e.g. `list_sessions`, `create_session`). May still take a
    /// `session_id` field in args if it operates on a specific session
    /// (e.g. `delete_session`, `send_message`).
    Global,
    /// Visible only at `/mcp/{id}`. Operates on the URL session id.
    /// `ToolCtx::session_id_required()` is guaranteed to return Ok here.
    SelfScoped,
}

/// Type-erased tool handler. Tool files don't write this directly — they
/// pass a typed async fn to `Tool::new` and the conversion happens there.
pub type ErasedHandler = Box<
    dyn Fn(ToolCtx, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>
        + Send
        + Sync,
>;

/// Per-call context handed to every tool handler. Carries enough state
/// for the handler to do its job without poking at AppState directly.
pub struct ToolCtx {
    state: AppState,
    /// `Some` when called via `/mcp/{id}` (URL session id), `None` when
    /// called via the bare `/mcp` route.
    session_id: Option<Uuid>,
}

impl ToolCtx {
    pub fn new(state: AppState, session_id: Option<Uuid>) -> Self {
        Self { state, session_id }
    }

    /// The URL session id, if any. Always `Some` for `Scope::SelfScoped`
    /// tools; may be either for `Scope::Global` tools (depends on which
    /// route they were called on).
    pub fn session_id(&self) -> Option<Uuid> {
        self.session_id
    }

    /// Convenience: returns the URL session id or a uniform error string
    /// matching the legacy `require_sid` shape. Use this in self-scoped
    /// tools where the caller's contract guarantees presence — the error
    /// would only fire on a misrouted call.
    pub fn session_id_required(&self) -> Result<Uuid, String> {
        self.session_id
            .ok_or_else(|| "this tool requires a per-session route /mcp/{session_id}".to_string())
    }

    pub fn manager(&self) -> SharedManager {
        self.state.manager.clone()
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// "Target session id" pattern: the explicit `arg` if provided, else
    /// the URL session id. Errors if neither is available — the global
    /// `/mcp` route can't default-from-URL, so callers must pass the arg.
    ///
    /// This is the right helper for tools that need to address some
    /// session, where "this session" is the natural default at /mcp/{id}
    /// but is meaningless at /mcp.
    pub fn target_session_id(&self, arg: Option<Uuid>) -> Result<Uuid, String> {
        arg.or(self.session_id).ok_or_else(|| {
            "session_id is required when calling at /mcp (no URL session id to default to)"
                .to_string()
        })
    }

    /// Resolve a chat-session name to its uuid. Acquires the manager lock
    /// briefly to read the name index. Returns a uniform error string when
    /// the name doesn't match any chat session — this surfaces to the
    /// calling AI as a tool error rather than an unhandled panic.
    pub async fn resolve_chat_session(&self, name: &str) -> Result<Uuid, String> {
        let mgr = self.state.manager.clone();
        let guard = mgr.lock().await;
        guard
            .id_by_chat_name(name)
            .ok_or_else(|| format!("no chat session named '{name}'"))
    }

    /// Chat-session counterpart of `target_session_id`: explicit name
    /// argument wins; otherwise fall back to the URL session id (which is
    /// always a uuid — that's how the per-session MCP route is mounted).
    /// Errors if neither is available.
    pub async fn target_chat_session(&self, arg: Option<&str>) -> Result<Uuid, String> {
        match arg {
            Some(name) => self.resolve_chat_session(name).await,
            None => self.session_id.ok_or_else(|| {
                "session name is required when calling at /mcp (no URL session id to default to)"
                    .to_string()
            }),
        }
    }
}

pub struct Tool {
    pub descriptor: ToolDescriptor,
    pub handler: ErasedHandler,
    pub scope: Scope,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::AppState;
    use crate::auth::{AuthConfig, LoginRateLimiter, SessionStore};
    use crate::conversation::new_shared_manager;
    use std::sync::Arc;

    fn dummy_ctx(session_id: Option<Uuid>) -> ToolCtx {
        let auth = AuthConfig {
            sessions: Arc::new(SessionStore::new()),
            rate_limiter: Arc::new(LoginRateLimiter::new()),
            token_hash: None,
            allowed_origins: Vec::new(),
            allowed_cidrs: Vec::new(),
            internal_token: Arc::new("test".to_string()),
        };
        let state = AppState {
            manager: new_shared_manager("/tmp"),
            auth,
            pending_questions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        };
        ToolCtx::new(state, session_id)
    }

    #[test]
    fn target_session_id_prefers_explicit_arg() {
        // Explicit arg always wins. This matters for /mcp/A calling
        // todo_read(session_id=B) — caller wants B, not A.
        let ctx = dummy_ctx(Some(Uuid::nil()));
        let arg = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        assert_eq!(ctx.target_session_id(Some(arg)).unwrap(), arg);
    }

    #[test]
    fn target_session_id_falls_back_to_url() {
        // /mcp/<id> with no arg → use the URL id. This is the "tell me
        // about my own todos" ergonomic path.
        let url_id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let ctx = dummy_ctx(Some(url_id));
        assert_eq!(ctx.target_session_id(None).unwrap(), url_id);
    }

    #[test]
    fn target_session_id_errors_on_global_route_with_no_arg() {
        // /mcp (no URL id) without an explicit arg has nothing to address
        // — must error rather than silently default to Uuid::nil().
        let ctx = dummy_ctx(None);
        assert!(ctx.target_session_id(None).is_err());
    }
}

/// One-line tool registration. Pass the name, description, scope, and a
/// path to an async fn `(ToolCtx, Args) -> Result<R, String>`. The macro
/// just calls `Tool::new` — its job is to keep call-sites short and read
/// like a table.
///
/// ```ignore
/// register_tool!("list_sessions", "List all neige sessions.", Scope::Global, list_sessions::handle)
/// ```
#[macro_export]
macro_rules! register_tool {
    ($name:expr, $desc:expr, $scope:expr, $handler:path $(,)?) => {
        $crate::mcp::registry::Tool::new($name, $desc, $scope, $handler)
    };
}

impl Tool {
    /// Build a tool from a typed async handler. The schema for `A` is
    /// derived via `schemars`, the handler's `R` is JSON-serialized on
    /// success, and on failure the error string lands in the standard MCP
    /// `isError: true` envelope (handled at the dispatch layer).
    pub fn new<A, R, F, Fut>(
        name: &'static str,
        description: &'static str,
        scope: Scope,
        handler: F,
    ) -> Self
    where
        A: DeserializeOwned + JsonSchema + Send + 'static,
        R: Serialize,
        F: Fn(ToolCtx, A) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, String>> + Send + 'static,
    {
        let input_schema = serde_json::to_value(schema_for!(A))
            .unwrap_or_else(|_| serde_json::json!({"type": "object"}));
        let descriptor = ToolDescriptor {
            name,
            description,
            input_schema,
        };
        let erased: ErasedHandler = Box::new(move |ctx, args| {
            // Two-stage so the async block can be `'static` regardless of
            // whether the Args parse succeeded — the parse error path
            // returns a ready future without ever calling the handler.
            match serde_json::from_value::<A>(args) {
                Ok(parsed) => {
                    let fut = handler(ctx, parsed);
                    Box::pin(async move {
                        let r = fut.await?;
                        serde_json::to_value(r).map_err(|e| format!("serialize result: {e}"))
                    })
                }
                Err(e) => {
                    let msg = format!("invalid arguments: {e}");
                    Box::pin(async move { Err(msg) })
                }
            }
        });
        Self {
            descriptor,
            handler: erased,
            scope,
        }
    }
}
