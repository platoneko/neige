use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Router,
    routing::{delete, get, post},
};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

use crate::auth::AuthConfig;
use crate::conversation::SharedManager;

mod chat_ws;
mod config;
mod conversations;
mod fs;
mod hooks;
mod proxy;
mod util;
mod ws;

/// Outstanding "ask user a question" requests, keyed by (session_id, question_id).
///
/// Populated by the MCP `ask_question` tool when an inner claude asks its
/// own session a question (self-target). The chat WS handler resolves the
/// oneshot when the user answers in the dialog. The tool call awaits the
/// receiver and returns the answer map to the caller.
///
/// Removed on either: success path (caller drains and removes after recv),
/// session deletion (kill_session sweeps), or sender drop (rx errors out
/// and the tool errors out cleanly).
pub type PendingQuestions =
    Arc<Mutex<HashMap<(Uuid, Uuid), oneshot::Sender<HashMap<String, String>>>>>;

#[derive(Clone)]
pub struct AppState {
    pub manager: SharedManager,
    pub auth: AuthConfig,
    pub pending_questions: PendingQuestions,
}

impl axum::extract::FromRef<AppState> for AuthConfig {
    fn from_ref(s: &AppState) -> Self {
        s.auth.clone()
    }
}

async fn healthz() -> &'static str {
    "ok"
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/healthz", get(healthz))
        .route("/api/conversations", get(conversations::list_convs))
        .route("/api/conversations", post(conversations::create_conv))
        .route("/api/browse", get(fs::browse_dir))
        .route("/api/is-git-repo", get(fs::check_is_git_repo))
        .route("/api/file", get(fs::read_file).head(fs::head_file))
        .route("/api/files", get(fs::search_files))
        .route("/api/conversations/{id}", delete(conversations::delete_conv))
        .route(
            "/api/conversations/{id}",
            axum::routing::patch(conversations::patch_conv),
        )
        .route(
            "/api/conversations/{id}/resume",
            post(conversations::resume_conv),
        )
        .route("/api/config", get(config::get_config))
        .route("/api/config", post(config::save_config))
        .route("/api/layout", get(config::get_layout))
        .route("/api/layout", post(config::save_layout))
        .route("/api/hooks/{id}", post(hooks::ingest_hook))
        .route("/api/proxy", get(proxy::proxy_request))
        .route("/ws/{id}", get(ws::ws_handler))
        .route("/ws/{id}/chat", get(chat_ws::chat_ws_handler))
}
