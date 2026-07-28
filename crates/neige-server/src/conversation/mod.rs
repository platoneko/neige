use crate::activity::Activity;
use crate::attach::SessionClient;
use crate::attach::chat::ChatSessionClient;
use crate::attach::daemon;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Detached,
    Dead,
}

/// How a conversation talks to its daemon. Terminal mode is the existing
/// PTY/xterm.js path; Chat mode runs the program headless under stream-json
/// and carries a server-globally-unique `name` that AI/MCP tools use to
/// address it (replacing the UUID at the AI-facing tool surface).
///
/// Internally tagged on `mode`: serializes as `{"mode":"terminal"}` for
/// terminal sessions and `{"mode":"chat","name":"..."}` for chat sessions.
/// Combined with `#[serde(flatten)]` on the carrying struct, this keeps the
/// JSON shape flat (sibling fields rather than nested), which means old
/// terminal session files written before chat existed still parse — and
/// the type system prevents constructing a chat session without a name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum SessionMode {
    #[default]
    Terminal,
    Chat {
        /// Stable, server-globally-unique handle used by AI/MCP tools to
        /// address this session (instead of UUID). Picked at create time;
        /// can be changed later via the rename API. Empty strings are
        /// rejected at construction.
        name: String,
    },
}

impl SessionMode {
    /// Convenience: returns the chat name if this is a chat session.
    pub fn chat_name(&self) -> Option<&str> {
        match self {
            SessionMode::Terminal => None,
            SessionMode::Chat { name } => Some(name),
        }
    }
}

/// Persisted session metadata stored in .neige/sessions/<id>.json
///
/// Manual `Deserialize` (not derived) because `#[serde(flatten, default)]`
/// cannot fall back to the unit variant when the internally-tagged enum's
/// discriminator field is absent — it errors on the missing tag. Pre-mode
/// session files (and pre-chat REST clients) must still load as Terminal,
/// so we route deserialization through `SessionMetaRaw` which captures the
/// mode-related fields into a generic map and inspects them for a `"mode"`
/// key before deciding whether to delegate to `SessionMode::deserialize`
/// or default to Terminal.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMeta {
    pub id: Uuid,
    pub title: String,
    pub program: String,
    pub cwd: String,
    pub proxy: Option<String>,
    pub use_worktree: bool,
    pub worktree_branch: Option<String>,
    pub created_at: String,
    pub last_active: String,
    /// The task this agent belongs to. `None` = this agent IS a task (its
    /// title is the task name, its cwd the task directory). `Some(root_id)`
    /// = child agent under that root. Nesting is exactly one level deep.
    /// Skipped when absent so root agents keep the pre-tasks wire shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Uuid>,
    #[serde(flatten)]
    pub mode: SessionMode,
}

#[derive(Deserialize)]
struct SessionMetaRaw {
    id: Uuid,
    title: String,
    program: String,
    cwd: String,
    proxy: Option<String>,
    use_worktree: bool,
    worktree_branch: Option<String>,
    created_at: String,
    last_active: String,
    #[serde(default)]
    parent_id: Option<Uuid>,
    #[serde(flatten)]
    mode_extra: serde_json::Map<String, serde_json::Value>,
}

impl<'de> Deserialize<'de> for SessionMeta {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let raw = SessionMetaRaw::deserialize(de)?;
        let mode = mode_from_extras(raw.mode_extra).map_err(serde::de::Error::custom)?;
        Ok(SessionMeta {
            id: raw.id,
            title: raw.title,
            program: raw.program,
            cwd: raw.cwd,
            proxy: raw.proxy,
            use_worktree: raw.use_worktree,
            worktree_branch: raw.worktree_branch,
            created_at: raw.created_at,
            last_active: raw.last_active,
            parent_id: raw.parent_id,
            mode,
        })
    }
}

/// Decide a `SessionMode` from the leftover fields captured by `flatten`.
/// Empty map (or one with no `mode` key) → Terminal, matching pre-mode
/// session-file shape. Otherwise delegate to `SessionMode::deserialize`,
/// which enforces the chat variant's `name` field.
fn mode_from_extras(
    extras: serde_json::Map<String, serde_json::Value>,
) -> Result<SessionMode, String> {
    if !extras.contains_key("mode") {
        return Ok(SessionMode::Terminal);
    }
    SessionMode::deserialize(serde_json::Value::Object(extras))
        .map_err(|e| format!("invalid mode/name fields: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvInfo {
    pub id: Uuid,
    pub title: String,
    pub status: Status,
    pub program: String,
    pub cwd: String,
    /// The actual working directory (worktree path if applicable, otherwise same as cwd)
    pub effective_cwd: String,
    pub created_at: String,
    pub use_worktree: bool,
    pub worktree_branch: Option<String>,
    /// See `SessionMeta::parent_id`. The absence of `skip_serializing_if`
    /// here — the one thing that differs from `SessionMeta`'s copy of this
    /// field — is load-bearing: it makes roots emit `"parent_id":null`, so
    /// the web client can type this as `string | null` instead of an
    /// optional key. Adding the skip to "unify the serde policy" breaks the
    /// hierarchy silently and totally: roots stop emitting the key,
    /// `parent.parent_id` reads `undefined`, `tasks.ts`'s
    /// `parent.parent_id !== null` goes true for every parent, and the
    /// sidebar and tab titles both flatten with no error anywhere.
    /// `parent_id_always_serialized_for_roots` locks this.
    #[serde(default)]
    pub parent_id: Option<Uuid>,
    /// What the agent in this session is doing, as opposed to `status`, which
    /// says whether the session's process is alive.
    pub activity: Activity,
    #[serde(flatten)]
    pub mode: SessionMode,
}

/// A single conversation backed by a session-daemon client. Exactly one of
/// `client` (terminal mode) or `chat_client` (chat mode) is populated when
/// the daemon is live, depending on `mode`.
pub struct Conversation {
    pub id: Uuid,
    pub title: String,
    pub program: String,
    pub cwd: String,
    pub proxy: Option<String>,
    pub use_worktree: bool,
    pub worktree_branch: Option<String>,
    pub parent_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub mode: SessionMode,
    pub client: Option<SessionClient>,
    pub chat_client: Option<ChatSessionClient>,
    /// Projected from Claude Code lifecycle hooks; see [`crate::activity`].
    /// Not persisted — a session reloaded from disk starts at `Unknown` and
    /// re-populates on the first hook its agent fires.
    pub activity: Activity,
    /// When `activity` was last written. Paired with it, and only ever read
    /// to answer "has anything backed this `Working` lately?" — see
    /// [`Activity::demote_if_stale`]. Write the two together, through
    /// [`ConversationManager::set_activity`].
    activity_set_at: Instant,
}

impl Conversation {
    pub fn info(&self) -> ConvInfo {
        let status = match &self.mode {
            SessionMode::Terminal => match &self.client {
                Some(c) if c.is_alive() => Status::Running,
                Some(_) => Status::Dead,
                None => Status::Detached,
            },
            SessionMode::Chat { .. } => match &self.chat_client {
                Some(c) if c.is_alive() => Status::Running,
                Some(_) => Status::Dead,
                None => Status::Detached,
            },
        };
        let effective_cwd = if self.use_worktree {
            find_worktree_cwd(&self.id, &self.cwd).unwrap_or_else(|| self.cwd.clone())
        } else {
            self.cwd.clone()
        };
        // Agent level first: drop a `Working` that no hook and no byte of
        // output has backed for a minute. Only then does the shell-level
        // signal get to answer for the sessions hooks say nothing about.
        let terminal = self.client.as_ref();
        let activity = self
            .activity
            .demote_if_stale(
                self.activity_set_at.elapsed(),
                terminal.and_then(|c| c.since_last_output()),
            )
            .resolve(terminal.and_then(|c| c.foreground_running()));
        ConvInfo {
            id: self.id,
            title: self.title.clone(),
            status,
            program: self.program.clone(),
            cwd: self.cwd.clone(),
            effective_cwd,
            created_at: self.created_at.to_rfc3339(),
            use_worktree: self.use_worktree,
            worktree_branch: self.worktree_branch.clone(),
            parent_id: self.parent_id,
            activity,
            mode: self.mode.clone(),
        }
    }

    pub fn meta(&self) -> SessionMeta {
        SessionMeta {
            id: self.id,
            title: self.title.clone(),
            program: self.program.clone(),
            cwd: self.cwd.clone(),
            proxy: self.proxy.clone(),
            use_worktree: self.use_worktree,
            worktree_branch: self.worktree_branch.clone(),
            created_at: self.created_at.to_rfc3339(),
            last_active: chrono::Utc::now().to_rfc3339(),
            parent_id: self.parent_id,
            mode: self.mode.clone(),
        }
    }
}

/// Body of `POST /api/conversations`. Same manual-`Deserialize` story as
/// `SessionMeta`: terminal-mode REST clients omit `mode` entirely and
/// expect Terminal; chat-mode clients send `mode: "chat"` with a sibling
/// `name`. Internally-tagged + flatten cannot model "missing tag → unit
/// variant default" through derive alone.
#[derive(Clone, Serialize)]
pub struct CreateConvRequest {
    pub title: String,
    #[serde(default = "default_program")]
    pub program: String,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    pub proxy: Option<String>,
    #[serde(default = "default_true")]
    pub use_worktree: bool,
    #[serde(default)]
    pub worktree_name: Option<String>,
    /// Create this agent inside an existing task. Absent = new task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Uuid>,
    #[serde(flatten)]
    pub mode: SessionMode,
}

#[derive(Deserialize)]
struct CreateConvRequestRaw {
    title: String,
    #[serde(default = "default_program")]
    program: String,
    #[serde(default = "default_cwd")]
    cwd: String,
    proxy: Option<String>,
    #[serde(default = "default_true")]
    use_worktree: bool,
    #[serde(default)]
    worktree_name: Option<String>,
    #[serde(default)]
    parent_id: Option<Uuid>,
    #[serde(flatten)]
    mode_extra: serde_json::Map<String, serde_json::Value>,
}

impl<'de> Deserialize<'de> for CreateConvRequest {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let raw = CreateConvRequestRaw::deserialize(de)?;
        let mode = mode_from_extras(raw.mode_extra).map_err(serde::de::Error::custom)?;
        // Empty strings get the same treatment as missing fields — clients
        // (e.g. Calm's "new terminal" button) can send `{cwd:"", program:""}`
        // when they have no sensible defaults and want the server to fall
        // back to $HOME / $SHELL instead of inheriting from another conv.
        let program = if raw.program.trim().is_empty() {
            default_program()
        } else {
            raw.program
        };
        let cwd = if raw.cwd.trim().is_empty() {
            default_cwd()
        } else {
            raw.cwd
        };
        Ok(CreateConvRequest {
            title: raw.title,
            program,
            cwd,
            proxy: raw.proxy,
            use_worktree: raw.use_worktree,
            worktree_name: raw.worktree_name,
            parent_id: raw.parent_id,
            mode,
        })
    }
}

fn default_program() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
}

fn default_cwd() -> String {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return home;
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn default_true() -> bool {
    true
}

/// Check if a directory is inside a git repository.
pub fn is_git_repo(path: &str) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Validate a user-supplied worktree name.
///
/// Claude CLI passes this through to `git worktree add -b worktree-<name>`, so
/// we require characters that are safe as both a shell arg and a git ref
/// component. Reject empty strings, whitespace, and anything outside
/// `[A-Za-z0-9._-]`.
fn sanitize_worktree_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Build the shell command for a program, adding claude-specific flags.
fn build_command(
    program: &str,
    session_id: &Uuid,
    use_worktree: bool,
    is_git: bool,
    worktree_name: Option<&str>,
) -> String {
    if program == "claude" || program.starts_with("claude ") {
        let mut parts = vec![program.to_string()];
        parts.push(format!("--session-id {}", session_id));
        if use_worktree && is_git {
            match worktree_name.and_then(sanitize_worktree_name) {
                Some(name) => parts.push(format!("--worktree {}", name)),
                None => parts.push("--worktree".to_string()),
            }
        }
        parts.join(" ")
    } else {
        program.to_string()
    }
}

/// Build proxy environment variables from a proxy URL.
///
/// Always pairs the proxy variables with a NO_PROXY exemption for the
/// loopback addresses. Chat-mode claudes hit the local MCP server at
/// `http://127.0.0.1:<port>/mcp/<id>` (see `write_mcp_config_file`); without
/// this exemption, an upstream proxy intercepts those requests and either
/// refuses internal addresses or routes them to the wrong host, breaking
/// every MCP tool call (introduce, send_message, etc.). NO_PROXY is set
/// even when no user proxy is provided, so any proxy inherited from the
/// surrounding shell environment also gets exempted for loopback.
fn proxy_env(proxy: Option<&str>) -> Vec<(String, String)> {
    // Cover the common loopback aliases. Most HTTP clients (curl, libcurl,
    // node, reqwest, fetch) treat NO_PROXY entries as substring/suffix
    // matches; "127.0.0.1,localhost,::1,0.0.0.0" works across all of them.
    let no_proxy = "127.0.0.1,localhost,::1,0.0.0.0";
    let mut env = vec![
        ("NO_PROXY".to_string(), no_proxy.to_string()),
        ("no_proxy".to_string(), no_proxy.to_string()),
    ];
    if let Some(p) = proxy {
        env.extend([
            ("HTTP_PROXY".to_string(), p.to_string()),
            ("HTTPS_PROXY".to_string(), p.to_string()),
            ("http_proxy".to_string(), p.to_string()),
            ("https_proxy".to_string(), p.to_string()),
        ]);
    }
    env
}

/// The environment every session's process starts with.
///
/// `NEIGE_SESSION_ID` is the load-bearing addition. It is inherited by
/// everything the user launches inside the session, so a `claude` typed by
/// hand at the shell prompt reports its lifecycle hooks back against the
/// right session — not just the ones neige spawns itself. The hook shim
/// no-ops when the variable is absent, which is what keeps a claude started
/// outside neige silent.
///
/// Gated on the same `disabled` kill-switch as MCP injection: a session the
/// user deliberately sandboxed from the orchestrator shouldn't report to it
/// either.
fn session_env(
    id: &Uuid,
    proxy: Option<&str>,
    inject: Option<&McpInjectConfig>,
) -> Vec<(String, String)> {
    let mut env = proxy_env(proxy);
    let Some(cfg) = inject.filter(|c| !c.disabled) else {
        return env;
    };
    env.push(("NEIGE_SESSION_ID".to_string(), id.to_string()));
    env.push(("NEIGE_SERVER_URL".to_string(), cfg.base_url.clone()));
    env.push((
        "NEIGE_HOOK_TOKEN".to_string(),
        cfg.internal_token.as_ref().clone(),
    ));
    env
}

/// Build the resume command for a claude session.
fn build_resume_command(program: &str, session_id: &Uuid) -> String {
    if program == "claude" || program.starts_with("claude ") {
        format!("claude --resume {}", session_id)
    } else {
        program.to_string()
    }
}

/// Find the worktree cwd where Claude CLI stored a session's conversation data.
///
/// When a session is created with `--worktree`, Claude CLI creates a git worktree
/// under `.claude/worktrees/{name}` and stores conversation data in a project
/// directory keyed by that worktree path. On resume, we need to find and use that
/// worktree path as the cwd so `claude --resume` can locate the conversation.
fn find_worktree_cwd(session_id: &Uuid, base_cwd: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let projects_dir = Path::new(&home).join(".claude").join("projects");
    let session_str = session_id.to_string();
    let base_encoded = base_cwd.replace('/', "-");

    for entry in std::fs::read_dir(&projects_dir).ok()?.flatten() {
        let dir_name = entry.file_name().to_string_lossy().to_string();

        // Only consider project dirs derived from our base repo that involve worktrees
        if !dir_name.starts_with(&base_encoded) || !dir_name.contains("worktrees-") {
            continue;
        }

        // Check if this project dir contains our session (as dir or .jsonl)
        let has_session = entry.path().join(&session_str).exists()
            || entry.path().join(format!("{}.jsonl", session_str)).exists();
        if !has_session {
            continue;
        }

        // Extract worktree name and construct the path
        if let Some(idx) = dir_name.find("worktrees-") {
            let name = &dir_name[idx + "worktrees-".len()..];
            let worktree_path = format!("{}/.claude/worktrees/{}", base_cwd, name);
            if Path::new(&worktree_path).exists() {
                tracing::info!(
                    "found worktree cwd for session {}: {}",
                    session_id, worktree_path
                );
                return Some(worktree_path);
            }
        }
    }
    None
}

/// Get the .neige directory for a project.
pub fn neige_dir(project_cwd: &str) -> PathBuf {
    Path::new(project_cwd).join(".neige")
}

/// Get the .neige sessions directory, relative to a project cwd.
fn sessions_dir(project_cwd: &str) -> PathBuf {
    neige_dir(project_cwd).join("sessions")
}

/// Save session metadata to .neige/sessions/<id>.json
fn save_session(meta: &SessionMeta, project_cwd: &str) {
    let dir = sessions_dir(project_cwd);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("failed to create sessions dir: {e}");
        return;
    }
    let path = dir.join(format!("{}.json", meta.id));
    match serde_json::to_string_pretty(meta) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                tracing::warn!("failed to save session {}: {e}", meta.id);
            }
        }
        Err(e) => tracing::warn!("failed to serialize session {}: {e}", meta.id),
    }
}

/// Remove session metadata file.
fn remove_session_file(id: &Uuid, project_cwd: &str) {
    let path = sessions_dir(project_cwd).join(format!("{}.json", id));
    let _ = std::fs::remove_file(path);
    // Also drop the auto-generated MCP config file (best-effort: missing
    // file is not an error). Holds a Bearer token, so we'd rather not
    // leave it lying around after the session it was scoped to is gone.
    let _ = std::fs::remove_file(mcp_config_path(id, project_cwd));
    // And the per-session todo list — same lifecycle as the session.
    let _ = std::fs::remove_file(todos_path(id, project_cwd));
}

// -- per-session todo list ---------------------------------------------------

/// One todo entry. Keeps the shape close to Claude Code's TodoWrite tool so
/// orchestrators that already know that vocabulary feel at home.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct Todo {
    /// Stable id within a session — the orchestrator picks it (string,
    /// arbitrary). Lets future updates reference an existing entry.
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub status: TodoStatus,
}

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
}

fn todos_path(id: &Uuid, project_cwd: &str) -> PathBuf {
    sessions_dir(project_cwd).join(format!("{}.todos.json", id))
}

/// Read the todo list for `id`. Empty list when the file is missing —
/// callers shouldn't have to special-case "first time" vs "really empty".
pub fn read_todos(id: &Uuid, project_cwd: &str) -> Vec<Todo> {
    let path = todos_path(id, project_cwd);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_else(|e| {
        tracing::warn!("failed to parse todos {path:?}: {e}");
        Vec::new()
    })
}

/// Replace the todo list for `id` wholesale. Mirrors Claude Code's
/// TodoWrite semantics — the orchestrator sends the full list, server
/// persists it. Atomic write via tempfile-rename so a crashed write can't
/// truncate to half a list.
pub fn write_todos(id: &Uuid, project_cwd: &str, todos: &[Todo]) -> Result<(), String> {
    let path = todos_path(id, project_cwd);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create todos dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(todos).map_err(|e| format!("serialize todos: {e}"))?;
    let tmp = path.with_extension("todos.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write todos tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename todos: {e}"))?;
    Ok(())
}

/// Load all session metadata from .neige/sessions/
fn load_sessions(project_cwd: &str) -> Vec<SessionMeta> {
    let dir = sessions_dir(project_cwd);
    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    match serde_json::from_str::<SessionMeta>(&content) {
                        Ok(meta) => sessions.push(meta),
                        Err(e) => tracing::warn!("failed to parse {}: {e}", path.display()),
                    }
                }
            }
        }
    }
    sessions
}

/// Ensure a daemon is up for `id` and connect a terminal client to it,
/// rolling back the daemon spawn if the client connect fails. Reused by
/// `create` and `resume` so both paths converge on the same cleanup
/// semantics.
async fn spawn_and_connect(
    id: &Uuid,
    command: &str,
    cwd: &str,
    env: &[(String, String)],
) -> Result<SessionClient, String> {
    // Idempotent: if a live daemon already exists `command`/env args are
    // ignored and `created` comes back false; in that case we don't kill
    // the (pre-existing) daemon on connect failure.
    let created = daemon::create_session(id, command, cwd, env).await?;
    match SessionClient::connect(id, 200, 50).await {
        Ok(client) => Ok(client),
        Err(e) => {
            if created {
                daemon::kill_session(id).await;
            }
            Err(e)
        }
    }
}

/// Same as `spawn_and_connect` but for chat-mode daemons. The argv is passed
/// to the daemon verbatim (no shell wrapping).
async fn spawn_and_connect_chat(
    id: &Uuid,
    argv: &[String],
    cwd: &str,
    env: &[(String, String)],
) -> Result<ChatSessionClient, String> {
    let created = daemon::create_chat_session(id, argv, cwd, env).await?;
    match ChatSessionClient::connect(id).await {
        Ok(client) => Ok(client),
        Err(e) => {
            if created {
                daemon::kill_session(id).await;
            }
            Err(e)
        }
    }
}

/// Settings for auto-injecting an `--mcp-config` file into chat sessions.
///
/// Stored on the manager and consulted at create/resume time. `base_url`
/// is *always* loopback for chat-spawned claudes (even when the server is
/// listening on 0.0.0.0) — the inner claude shares a host with the server.
#[derive(Clone)]
pub struct McpInjectConfig {
    pub base_url: String,
    pub internal_token: std::sync::Arc<String>,
    /// If true, skip injection entirely. Useful as a kill-switch when the
    /// inner claude shouldn't be aware of the orchestrator (e.g. the user
    /// wants completely sandboxed sessions).
    pub disabled: bool,
}

impl McpInjectConfig {
    pub fn loopback(port: u16, internal_token: std::sync::Arc<String>, disabled: bool) -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            internal_token,
            disabled,
        }
    }
}

/// Settings for the chat-mode Node runner that the daemon spawns instead of
/// `claude --print` directly.
///
/// Track A's `runners/neige-chat-runner/` is a Node sidecar built on the
/// official `@anthropic-ai/claude-agent-sdk`. The Rust daemon (Track B)
/// spawns `node <runner-path> --session-id ... --cwd ... [--resume]
/// [--mcp-config ...]` and pipes its stdout (NeigeEvent JSON lines) the same
/// way it used to pipe claude's stream-json output.
///
/// `path` is the absolute path to the runner's compiled `cli.js`, computed
/// once at startup by `resolve_runner_path` and threaded through the
/// manager so every chat-session create / resume sees the same value.
#[derive(Clone)]
pub struct RunnerConfig {
    pub path: PathBuf,
}

/// Resolve the path to the chat-runner CLI entrypoint.
///
/// Resolution order (first hit wins):
///   1. `NEIGE_RUNNER_PATH` env var, if set and non-empty.
///   2. Sibling-of-binary lookup: `<exe-dir>/../../runners/neige-chat-runner/dist/cli.js`,
///      walking up from `std::env::current_exe()` so packaged builds find
///      the runner relative to the neige-server binary.
///   3. Workspace fallback: `runners/neige-chat-runner/dist/cli.js` joined
///      onto the `cargo` workspace root (parent of `CARGO_MANIFEST_DIR`),
///      so `cargo run` from a fresh checkout works without env setup.
///
/// Returns the resolved path even if the file doesn't exist on disk —
/// the daemon will surface the spawn failure with a clearer error than this
/// resolver could ("ENOENT on `node <path>`") so we don't try to be cleverer
/// here.
pub fn resolve_runner_path() -> PathBuf {
    if let Ok(p) = std::env::var("NEIGE_RUNNER_PATH")
        && !p.is_empty()
    {
        return PathBuf::from(p);
    }
    // Sibling-of-binary first so installed/packaged setups don't accidentally
    // resolve to a stale workspace clone hanging around in CARGO_MANIFEST_DIR.
    if let Ok(exe) = std::env::current_exe()
        && let Some(bin_dir) = exe.parent()
    {
        // <bin_dir>/../runners/neige-chat-runner/dist/cli.js — covers
        // `target/release/` and `target/debug/` siblings of `runners/`.
        if let Some(workspace_guess) = bin_dir.parent().and_then(|p| p.parent()) {
            let candidate = workspace_guess
                .join("runners")
                .join("neige-chat-runner")
                .join("dist")
                .join("cli.js");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    // Workspace fallback — handy in dev where the binary lives in
    // target/{debug,release}/ and the runner sits at the workspace root.
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let workspace = std::path::Path::new(manifest_dir)
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    workspace
        .join("runners")
        .join("neige-chat-runner")
        .join("dist")
        .join("cli.js")
}

/// Path of the per-session MCP config file (lives next to session metadata).
fn mcp_config_path(id: &Uuid, project_cwd: &str) -> PathBuf {
    sessions_dir(project_cwd).join(format!("{}.mcp.json", id))
}

/// Write a per-session `mcp-internal.json` referencing the global `/mcp` route
/// so the inner claude can list/create/send to sibling sessions, plus the
/// per-session `/mcp/<id>` route for self-scoped tools (read_log/stop/get_info).
///
/// Returns `Some(path)` on success (caller passes it to `--mcp-config`), or
/// `None` if injection is disabled. Errors are logged + treated as "no inject"
/// — a missing config file is recoverable, a panicked spawn isn't.
fn write_mcp_config_file(
    id: &Uuid,
    project_cwd: &str,
    cfg: &McpInjectConfig,
) -> Option<PathBuf> {
    if cfg.disabled {
        return None;
    }
    let path = mcp_config_path(id, project_cwd);
    if let Some(parent) = path.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        tracing::warn!("failed to create mcp config dir: {e}");
        return None;
    }

    // Two entries:
    //   - `neige`             → /mcp/<id>      (self + global tools merged)
    //   - `neige_orchestrate` → /mcp           (global tools only — handy if
    //                            the inner claude wants the *strict* shape
    //                            without self-scoped tools cluttering)
    let auth_header = format!("Bearer {}", cfg.internal_token);
    let body = serde_json::json!({
        "mcpServers": {
            "neige": {
                "type": "http",
                "url": format!("{}/mcp/{}", cfg.base_url, id),
                "headers": {"Authorization": auth_header},
            },
        }
    });

    let json = match serde_json::to_string_pretty(&body) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("failed to serialize mcp config: {e}");
            return None;
        }
    };

    if let Err(e) = std::fs::write(&path, json) {
        tracing::warn!("failed to write mcp config {path:?}: {e}");
        return None;
    }
    // Mode 0600 — the file holds a Bearer token. Best-effort; we don't
    // fatally fail if the platform refuses (Windows / unusual filesystems).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(path)
}

/// Build the daemon flag list for a chat-mode session.
///
/// Returns the *flags* the `neige-session-daemon --mode chat` invocation
/// needs (NOT a full argv). The daemon itself spawns `node <runner-path>`
/// internally per these flags — we no longer hand-roll claude argv on the
/// server side. The hand-rolled `--print --verbose --input-format=...
/// --disallowedTools AskUserQuestion` story moved into the runner: the
/// official `@anthropic-ai/claude-agent-sdk` already handles stream-json
/// framing, partial messages, and hook events natively, and the runner
/// owns canUseTool so AskUserQuestion no longer has to be blocked.
///
/// Flag order:
///   `--runner-path <path> --cwd <cwd>`
///   `[--resume] [--mcp-config <path>] [--program <program>]`
///
/// The session uuid is NOT in this list — the daemon already receives it
/// via its own pre-existing `--id` flag (assembled by `spawn_daemon`) and
/// forwards it to the runner as `--session-id` internally. Adding
/// `--session-id` here would duplicate the value and trip the daemon's
/// clap parser, which doesn't define that flag.
///
/// `program` is forwarded as informational metadata (the runner doesn't
/// shell out — claude is loaded as an SDK module) but kept on the wire so
/// the daemon can log it.
fn build_runner_args(
    runner_path: &Path,
    program: &str,
    cwd: &str,
    resume: bool,
    mcp_config_path: Option<&Path>,
) -> Vec<String> {
    let mut args = vec![
        "--runner-path".to_string(),
        runner_path.to_string_lossy().to_string(),
        "--cwd".to_string(),
        cwd.to_string(),
    ];
    if resume {
        args.push("--resume".to_string());
    }
    if let Some(path) = mcp_config_path {
        args.push("--mcp-config".to_string());
        args.push(path.to_string_lossy().to_string());
    }
    if !program.is_empty() {
        args.push("--program".to_string());
        args.push(program.to_string());
    }
    args
}

/// Manages all conversations.
pub struct ConversationManager {
    convs: HashMap<Uuid, Conversation>,
    /// Secondary index for chat sessions: chat name → uuid. Lets MCP tools
    /// resolve a name handed in by an AI caller to the internal Conversation
    /// in O(1). Only chat sessions are inserted; terminal sessions never
    /// participate in name addressing. Kept in sync by `create`, `remove`,
    /// `rename_chat`, and `load_from_disk`.
    chat_by_name: HashMap<String, Uuid>,
    /// The base project directory (where .neige/ lives)
    project_cwd: String,
    /// MCP injection settings for chat sessions. None means no injection
    /// (e.g. unit tests that don't need it); otherwise written into a
    /// per-session JSON and passed to claude via `--mcp-config`.
    mcp_inject: Option<McpInjectConfig>,
    /// Resolved runner CLI path threaded into every chat-session spawn.
    /// None disables chat creation (resume on a chat session also fails) —
    /// only relevant in unit tests that never spawn chats.
    runner: Option<RunnerConfig>,
}

impl ConversationManager {
    pub fn new(project_cwd: &str) -> Self {
        Self::with_config(project_cwd, None, None)
    }

    pub fn with_mcp_inject(project_cwd: &str, mcp_inject: Option<McpInjectConfig>) -> Self {
        Self::with_config(project_cwd, mcp_inject, None)
    }

    pub fn with_config(
        project_cwd: &str,
        mcp_inject: Option<McpInjectConfig>,
        runner: Option<RunnerConfig>,
    ) -> Self {
        let mut mgr = Self {
            convs: HashMap::new(),
            chat_by_name: HashMap::new(),
            project_cwd: project_cwd.to_string(),
            mcp_inject,
            runner,
        };
        mgr.load_from_disk();
        mgr
    }

    pub fn project_cwd(&self) -> &str {
        &self.project_cwd
    }

    /// Load persisted sessions from .neige/sessions/ as detached conversations.
    fn load_from_disk(&mut self) {
        let sessions = load_sessions(&self.project_cwd);
        for meta in sessions {
            let created_at = chrono::DateTime::parse_from_rfc3339(&meta.created_at)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());
            // Reject duplicate chat names defensively (shouldn't happen given
            // the create-time uniqueness check, but a hand-edited session
            // file could). The first occurrence wins; subsequent ones load
            // their conv but leave the name index pointing at the original.
            if let SessionMode::Chat { name } = &meta.mode {
                match self.chat_by_name.get(name) {
                    Some(existing) if *existing != meta.id => {
                        tracing::warn!(
                            "duplicate chat name '{name}' on disk: keeping {existing}, \
                             leaving {} unindexed (rename it via the API to make it \
                             addressable again)",
                            meta.id
                        );
                    }
                    _ => {
                        self.chat_by_name.insert(name.clone(), meta.id);
                    }
                }
            }
            let conv = Conversation {
                id: meta.id,
                title: meta.title,
                program: meta.program,
                cwd: meta.cwd,
                proxy: meta.proxy,
                use_worktree: meta.use_worktree,
                worktree_branch: meta.worktree_branch,
                parent_id: meta.parent_id,
                created_at,
                mode: meta.mode,
                client: None, // detached
                chat_client: None,
                activity: Activity::Unknown,
                activity_set_at: Instant::now(),
            };
            self.convs.insert(conv.id, conv);
        }
        if !self.convs.is_empty() {
            tracing::info!("loaded {} sessions from disk", self.convs.len());
        }
    }

    /// Validate that `parent_id` names an existing root agent. Split out of
    /// `create` so the rule is unit-testable without spawning a daemon.
    fn validate_parent(&self, parent_id: &Uuid) -> Result<(), String> {
        let parent = self
            .convs
            .get(parent_id)
            .ok_or_else(|| format!("parent session {parent_id} not found"))?;
        if parent.parent_id.is_some() {
            return Err("agents cannot nest more than one level".to_string());
        }
        Ok(())
    }

    /// Ids of the child agents belonging to task `id`. Empty when `id` is
    /// itself a child, since nesting is one level deep.
    fn children_of(&self, id: &Uuid) -> Vec<Uuid> {
        self.convs
            .values()
            .filter(|c| c.parent_id == Some(*id))
            .map(|c| c.id)
            .collect()
    }

    pub async fn create(&mut self, req: CreateConvRequest) -> Result<ConvInfo, String> {
        let id = Uuid::new_v4();
        let cwd = if req.cwd.is_empty() {
            self.project_cwd.clone()
        } else {
            req.cwd.clone()
        };
        let title = if req.title.is_empty() || req.title == "untitled" {
            std::path::Path::new(&cwd)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("untitled")
                .to_string()
        } else {
            req.title.clone()
        };

        let is_git = is_git_repo(&cwd);
        let use_worktree = req.use_worktree && is_git;
        let env = session_env(&id, req.proxy.as_deref(), self.mcp_inject.as_ref());

        // Validate chat name up front: must be non-empty (uniqueness check
        // happens in commit 2 once the manager carries a name index).
        if let SessionMode::Chat { name } = &req.mode
            && name.trim().is_empty()
        {
            return Err("chat session requires a non-empty name".to_string());
        }
        if let SessionMode::Chat { name } = &req.mode
            && self.chat_by_name.contains_key(name)
        {
            return Err(format!("chat session name '{name}' already in use"));
        }

        if let Some(parent_id) = req.parent_id {
            self.validate_parent(&parent_id)?;
        }

        let (client, chat_client, worktree_branch) = match &req.mode {
            SessionMode::Terminal => {
                let command = build_command(
                    &req.program,
                    &id,
                    use_worktree,
                    is_git,
                    req.worktree_name.as_deref(),
                );
                let worktree_branch = if use_worktree
                    && (req.program == "claude" || req.program.starts_with("claude "))
                {
                    Some(format!("neige/{}", id))
                } else {
                    None
                };
                tracing::info!(
                    "spawning terminal session {id}: command={command:?}, cwd={cwd:?}, is_git={is_git}, use_worktree={use_worktree}"
                );
                let client = spawn_and_connect(&id, &command, &cwd, &env).await?;
                (Some(client), None, worktree_branch)
            }
            SessionMode::Chat { .. } => {
                // Worktrees are a Claude CLI feature wired through the
                // `--worktree` flag, which only makes sense when claude
                // owns the session. The headless chat path doesn't manage
                // worktrees yet — we just spawn in `cwd` directly.
                let mcp_path = self
                    .mcp_inject
                    .as_ref()
                    .and_then(|cfg| write_mcp_config_file(&id, &self.project_cwd, cfg));
                let runner_path = self
                    .runner
                    .as_ref()
                    .map(|r| r.path.clone())
                    .ok_or_else(|| {
                        "chat session requested but no runner path configured \
                         (set NEIGE_RUNNER_PATH or build runners/neige-chat-runner)"
                            .to_string()
                    })?;
                let runner_args = build_runner_args(
                    &runner_path,
                    &req.program,
                    &cwd,
                    false,
                    mcp_path.as_deref(),
                );
                tracing::info!(
                    "spawning chat session {id}: runner_args={runner_args:?}, cwd={cwd:?}"
                );
                let chat = spawn_and_connect_chat(&id, &runner_args, &cwd, &env).await?;
                (None, Some(chat), None)
            }
        };

        let conv = Conversation {
            id,
            title,
            program: req.program,
            cwd,
            proxy: req.proxy,
            use_worktree,
            worktree_branch,
            parent_id: req.parent_id,
            created_at: chrono::Utc::now(),
            mode: req.mode,
            client,
            chat_client,
            activity: Activity::Unknown,
            activity_set_at: Instant::now(),
        };

        let info = conv.info();
        save_session(&conv.meta(), &self.project_cwd);
        if let SessionMode::Chat { name } = &conv.mode {
            self.chat_by_name.insert(name.clone(), id);
        }
        self.convs.insert(id, conv);
        Ok(info)
    }

    /// Resume a detached session by reattaching to its live daemon (or
    /// spawning a fresh one with a `--resume` command if the daemon's gone).
    pub async fn resume(&mut self, id: &Uuid) -> Result<ConvInfo, String> {
        let conv = self.convs.get_mut(id)
            .ok_or_else(|| "session not found".to_string())?;

        match &conv.mode {
            SessionMode::Terminal => {
                if conv.client.as_ref().is_some_and(|c| c.is_alive()) {
                    return Ok(conv.info());
                }

                let command = build_resume_command(&conv.program, &conv.id);
                let env = session_env(&conv.id, conv.proxy.as_deref(), self.mcp_inject.as_ref());

                // For worktree sessions, find the actual worktree path where
                // Claude CLI stored the conversation data; fall back to the
                // saved cwd.
                let cwd = if conv.use_worktree {
                    find_worktree_cwd(&conv.id, &conv.cwd).unwrap_or_else(|| conv.cwd.clone())
                } else {
                    conv.cwd.clone()
                };

                // Idempotent: if the daemon from before the neige-server restart is
                // still alive, create_session short-circuits and `command`/env args
                // are ignored — the user reattaches to the same live claude. If the
                // daemon is gone, a fresh one is spawned with the resume command.
                let client = spawn_and_connect(&conv.id, &command, &cwd, &env).await?;
                conv.client = Some(client);
            }
            SessionMode::Chat { .. } => {
                if conv.chat_client.as_ref().is_some_and(|c| c.is_alive()) {
                    return Ok(conv.info());
                }
                // Rewrite the MCP config in case the internal token rotated
                // since the previous spawn (server restart). Cheap, and
                // keeps the file's lifetime aligned with the daemon's.
                let mcp_path = self
                    .mcp_inject
                    .as_ref()
                    .and_then(|cfg| write_mcp_config_file(&conv.id, &self.project_cwd, cfg));
                let runner_path = self
                    .runner
                    .as_ref()
                    .map(|r| r.path.clone())
                    .ok_or_else(|| {
                        "chat session resume requested but no runner path configured \
                         (set NEIGE_RUNNER_PATH or build runners/neige-chat-runner)"
                            .to_string()
                    })?;
                let cwd = conv.cwd.clone();
                let runner_args = build_runner_args(
                    &runner_path,
                    &conv.program,
                    &cwd,
                    true,
                    mcp_path.as_deref(),
                );
                let env = session_env(&conv.id, conv.proxy.as_deref(), self.mcp_inject.as_ref());
                let chat = spawn_and_connect_chat(&conv.id, &runner_args, &cwd, &env).await?;
                conv.chat_client = Some(chat);
            }
        }

        save_session(&conv.meta(), &self.project_cwd);
        Ok(conv.info())
    }

    pub fn list(&self) -> Vec<ConvInfo> {
        let mut list: Vec<_> = self.convs.values().map(|c| c.info()).collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        list
    }

    pub fn get(&self, id: &Uuid) -> Option<&Conversation> {
        self.convs.get(id)
    }

    /// Record what the agent in `id` is doing. Last event wins: every
    /// transition is caused by a lifecycle hook, so the most recent one is by
    /// definition the current truth. The stamp taken alongside it is not a
    /// timer racing that truth — it only lets a read notice a `Working` whose
    /// turn ended without firing anything.
    ///
    /// Returns `false` for an unknown id, which is normal rather than an
    /// error: a hook can arrive from a claude the user launched by hand
    /// inside a session that has since been deleted.
    pub fn set_activity(&mut self, id: &Uuid, activity: Activity) -> bool {
        match self.convs.get_mut(id) {
            Some(conv) => {
                conv.activity = activity;
                conv.activity_set_at = Instant::now();
                true
            }
            None => false,
        }
    }

    /// Resolve a chat session name to its uuid. Returns `None` for unknown
    /// names or if the named session isn't currently loaded. Terminal
    /// sessions are never indexed by name and won't appear here.
    pub fn id_by_chat_name(&self, name: &str) -> Option<Uuid> {
        self.chat_by_name.get(name).copied()
    }

    /// Resolve a chat session name straight to its Conversation. Convenience
    /// over `id_by_chat_name` + `get` for callers that need the conv directly.
    pub fn get_by_chat_name(&self, name: &str) -> Option<&Conversation> {
        self.id_by_chat_name(name).and_then(|id| self.convs.get(&id))
    }

    /// Update conversation metadata (e.g. title). Title is a free-form
    /// display label; no uniqueness check. To rename a chat session's
    /// addressing handle, call `rename_chat` instead.
    pub fn update(&mut self, id: &Uuid, title: Option<&str>) -> Option<ConvInfo> {
        let conv = self.convs.get_mut(id)?;
        if let Some(t) = title {
            conv.title = t.to_string();
        }
        save_session(&conv.meta(), &self.project_cwd);
        Some(conv.info())
    }

    /// Rename a chat session's addressing handle. Errors if the target is
    /// not a chat session, the new name is empty, or the new name collides
    /// with another chat session. The `chat_by_name` index is updated
    /// atomically with the in-memory model and the persisted metadata.
    pub fn rename_chat(&mut self, id: &Uuid, new_name: &str) -> Result<ConvInfo, String> {
        let trimmed = new_name.trim();
        if trimmed.is_empty() {
            return Err("chat session name cannot be empty".to_string());
        }
        // Uniqueness check before mutating anything. A no-op rename (same
        // name to same session) is allowed and returns Ok.
        if let Some(existing) = self.chat_by_name.get(trimmed)
            && existing != id
        {
            return Err(format!("chat session name '{trimmed}' already in use"));
        }
        let conv = self
            .convs
            .get_mut(id)
            .ok_or_else(|| "session not found".to_string())?;
        let old_name = match &conv.mode {
            SessionMode::Chat { name } => name.clone(),
            SessionMode::Terminal => {
                return Err(
                    "cannot rename a terminal session (only chat sessions have names)".to_string(),
                );
            }
        };
        conv.mode = SessionMode::Chat {
            name: trimmed.to_string(),
        };
        // Drop the old index entry first so a same-name no-op rename doesn't
        // briefly leave a stale entry between remove and insert.
        if old_name != trimmed {
            self.chat_by_name.remove(&old_name);
            self.chat_by_name.insert(trimmed.to_string(), *id);
        }
        save_session(&conv.meta(), &self.project_cwd);
        Ok(conv.info())
    }

    /// Remove a conversation and clean up its session file. Deleting a task
    /// (a root agent) takes its child agents with it.
    pub async fn remove(&mut self, id: &Uuid) {
        // `children_of` returns an owned Vec rather than an iterator because
        // `remove_one` takes `&mut self` — borrowing `convs` for the loop and
        // mutating it in the body can't coexist. Making the kill synchronous
        // would not change that.
        for child in self.children_of(id) {
            self.remove_one(&child).await;
        }
        self.remove_one(id).await;
    }

    /// Remove exactly one conversation, no cascade.
    async fn remove_one(&mut self, id: &Uuid) {
        // Kill the session daemon so the inner program stops; dropping only
        // our socket would leave the daemon (and the claude it's running)
        // orphaned.
        daemon::kill_session(id).await;
        remove_session_file(id, &self.project_cwd);
        if let Some(conv) = self.convs.remove(id)
            && let SessionMode::Chat { name } = &conv.mode
        {
            // Only drop the index entry if it still points at this id —
            // a rename mid-flight would have already replaced it.
            if self.chat_by_name.get(name).copied() == Some(*id) {
                self.chat_by_name.remove(name);
            }
        }
    }
}

pub type SharedManager = Arc<Mutex<ConversationManager>>;

pub fn new_shared_manager(project_cwd: &str) -> SharedManager {
    Arc::new(Mutex::new(ConversationManager::new(project_cwd)))
}

pub fn new_shared_manager_with_inject(
    project_cwd: &str,
    mcp_inject: Option<McpInjectConfig>,
) -> SharedManager {
    Arc::new(Mutex::new(ConversationManager::with_mcp_inject(
        project_cwd,
        mcp_inject,
    )))
}

pub fn new_shared_manager_with_config(
    project_cwd: &str,
    mcp_inject: Option<McpInjectConfig>,
    runner: Option<RunnerConfig>,
) -> SharedManager {
    Arc::new(Mutex::new(ConversationManager::with_config(
        project_cwd,
        mcp_inject,
        runner,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_mode_terminal_round_trips_via_meta() {
        // SessionMode is internally tagged on `mode` and only meaningful when
        // flattened into a carrying struct (the tag field becomes a sibling
        // of the struct's fields). Round-trip through SessionMeta to reflect
        // how it actually serializes on the wire.
        let meta = SessionMeta {
            id: Uuid::nil(),
            title: "t".into(),
            program: "claude".into(),
            cwd: "/tmp".into(),
            proxy: None,
            use_worktree: false,
            worktree_branch: None,
            created_at: "2024-01-01T00:00:00Z".into(),
            last_active: "2024-01-01T00:00:00Z".into(),
            parent_id: None,
            mode: SessionMode::Terminal,
        };
        let s = serde_json::to_string(&meta).unwrap();
        assert!(s.contains(r#""mode":"terminal""#));
        // No `name` field on terminal sessions.
        assert!(!s.contains(r#""name""#));
        let parsed: SessionMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.mode, SessionMode::Terminal);
    }

    #[test]
    fn session_mode_chat_carries_name_in_flat_json() {
        // Chat variant flattens its `name` field next to `mode` rather than
        // nesting it. Locks the wire shape AI clients see.
        let meta = SessionMeta {
            id: Uuid::nil(),
            title: "t".into(),
            program: "claude".into(),
            cwd: "/tmp".into(),
            proxy: None,
            use_worktree: false,
            worktree_branch: None,
            created_at: "2024-01-01T00:00:00Z".into(),
            last_active: "2024-01-01T00:00:00Z".into(),
            parent_id: None,
            mode: SessionMode::Chat {
                name: "scraper".into(),
            },
        };
        let s = serde_json::to_string(&meta).unwrap();
        assert!(s.contains(r#""mode":"chat""#));
        assert!(s.contains(r#""name":"scraper""#));
        let parsed: SessionMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(
            parsed.mode,
            SessionMode::Chat {
                name: "scraper".into()
            }
        );
    }

    #[test]
    fn parent_id_always_serialized_for_roots() {
        // A root must put `parent_id` on the wire as an explicit null. If it
        // is ever skipped instead, the web client reads `undefined` and the
        // whole task hierarchy flattens without raising anything — see the
        // field's doc comment on `ConvInfo`.
        let info = ConvInfo {
            id: Uuid::nil(),
            title: "t".into(),
            status: Status::Detached,
            program: "claude".into(),
            cwd: "/tmp".into(),
            effective_cwd: "/tmp".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            use_worktree: false,
            worktree_branch: None,
            parent_id: None,
            activity: Activity::Unknown,
            mode: SessionMode::Terminal,
        };
        let s = serde_json::to_string(&info).unwrap();
        assert!(s.contains(r#""parent_id":null"#), "got {s}");
    }

    #[test]
    fn session_mode_default_is_terminal() {
        assert_eq!(SessionMode::default(), SessionMode::Terminal);
    }

    #[test]
    fn legacy_session_meta_loads_as_terminal() {
        // Pre-`mode`-field session files must still deserialize, defaulting
        // to Terminal (achieved via `#[serde(flatten, default)]`).
        let legacy = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "title": "old",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
            "worktree_branch": null,
            "created_at": "2024-01-01T00:00:00Z",
            "last_active": "2024-01-01T00:00:00Z",
        });
        let meta: SessionMeta = serde_json::from_value(legacy).unwrap();
        assert_eq!(meta.mode, SessionMode::Terminal);
    }

    #[test]
    fn explicit_terminal_session_meta_loads() {
        // Sessions written after `mode` was added (but before chat existed)
        // include `mode: "terminal"` explicitly and no `name` field.
        let v = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "title": "old",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
            "worktree_branch": null,
            "created_at": "2024-01-01T00:00:00Z",
            "last_active": "2024-01-01T00:00:00Z",
            "mode": "terminal",
        });
        let meta: SessionMeta = serde_json::from_value(v).unwrap();
        assert_eq!(meta.mode, SessionMode::Terminal);
    }

    #[test]
    fn chat_session_meta_without_name_fails() {
        // Pre-launch invariant: chat-mode persistence MUST carry `name`.
        // If a hand-written or pre-name-field chat session file shows up,
        // we want a hard parse error rather than silently constructing a
        // chat session with an empty name.
        let v = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "title": "old chat",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
            "worktree_branch": null,
            "created_at": "2024-01-01T00:00:00Z",
            "last_active": "2024-01-01T00:00:00Z",
            "mode": "chat",
        });
        assert!(serde_json::from_value::<SessionMeta>(v).is_err());
    }

    #[test]
    fn create_conv_request_default_mode_is_terminal() {
        let body = serde_json::json!({
            "title": "x",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
        });
        let req: CreateConvRequest = serde_json::from_value(body).unwrap();
        assert_eq!(req.mode, SessionMode::Terminal);
    }

    #[test]
    fn create_conv_request_accepts_chat_mode_with_name() {
        let body = serde_json::json!({
            "title": "x",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
            "mode": "chat",
            "name": "scraper",
        });
        let req: CreateConvRequest = serde_json::from_value(body).unwrap();
        assert_eq!(
            req.mode,
            SessionMode::Chat {
                name: "scraper".into()
            }
        );
    }

    #[test]
    fn create_conv_request_chat_mode_without_name_fails() {
        // Type-system invariant: `mode: "chat"` requires `name`. The wire
        // shape rejects requests that omit it, before any handler runs.
        let body = serde_json::json!({
            "title": "x",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
            "mode": "chat",
        });
        assert!(serde_json::from_value::<CreateConvRequest>(body).is_err());
    }

    /// Helper: pluck the value following a flag, asserting the flag is present.
    /// Returns None if the flag isn't there at all (caller asserts on that).
    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let mut iter = args.iter();
        while let Some(a) = iter.next() {
            if a == flag {
                return iter.next().map(|s| s.as_str());
            }
        }
        None
    }

    #[test]
    fn build_runner_args_fresh_omits_resume() {
        // Fresh sessions don't carry `--resume` — the daemon (and, downstream,
        // the runner SDK) starts a new conversation. The session uuid is
        // delivered separately via the daemon's own `--id` flag (assembled by
        // `spawn_daemon`), so build_runner_args neither emits nor needs it.
        let runner = std::path::PathBuf::from("/opt/neige/runner.js");
        let args = build_runner_args(&runner, "claude", "/tmp", false, None);
        assert!(!args.iter().any(|a| a == "--resume"));
        // Locked: session-id MUST NOT be in the runner-args list, otherwise
        // it duplicates the daemon's `--id` and trips the daemon's clap.
        assert!(!args.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn build_runner_args_resume_uses_resume_flag() {
        let runner = std::path::PathBuf::from("/opt/neige/runner.js");
        let args = build_runner_args(&runner, "claude", "/tmp", true, None);
        assert!(args.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn build_runner_args_threads_mcp_config_path() {
        // The runner forwards `--mcp-config` straight to the inner claude
        // SDK, so the file written by `write_mcp_config_file` still lands
        // in the right place.
        let runner = std::path::PathBuf::from("/opt/neige/runner.js");
        let mcp = std::path::PathBuf::from("/tmp/neige-fake-mcp.json");
        let args = build_runner_args(&runner, "claude", "/tmp", false, Some(&mcp));
        assert_eq!(
            flag_value(&args, "--mcp-config"),
            Some("/tmp/neige-fake-mcp.json")
        );
    }

    #[test]
    fn build_runner_args_omits_mcp_config_when_none() {
        // None means injection is off (or unit-test scope); the flag must
        // not appear at all so the runner falls back to its default.
        let runner = std::path::PathBuf::from("/opt/neige/runner.js");
        let args = build_runner_args(&runner, "claude", "/tmp", false, None);
        assert!(!args.iter().any(|a| a == "--mcp-config"));
    }

    #[test]
    fn build_runner_args_threads_runner_path() {
        // `--runner-path` is required by the daemon CLI; it tells the
        // daemon which Node entrypoint to spawn.
        let runner = std::path::PathBuf::from("/opt/neige/runner.js");
        let args = build_runner_args(&runner, "claude", "/tmp", false, None);
        assert_eq!(flag_value(&args, "--runner-path"), Some("/opt/neige/runner.js"));
    }

    #[test]
    fn build_runner_args_threads_cwd_and_program() {
        // cwd is required (runner uses it to set the SDK's working dir).
        // program is informational but kept on the wire so the daemon can
        // log it — locking it here so a future refactor doesn't quietly
        // drop it.
        let runner = std::path::PathBuf::from("/opt/neige/runner.js");
        let args = build_runner_args(&runner, "claude --custom", "/srv/work", false, None);
        assert_eq!(flag_value(&args, "--cwd"), Some("/srv/work"));
        assert_eq!(flag_value(&args, "--program"), Some("claude --custom"));
    }

    #[test]
    fn write_mcp_config_file_respects_disabled_flag() {
        let dir = tempdir_for_test();
        let cfg = McpInjectConfig {
            base_url: "http://127.0.0.1:3030".to_string(),
            internal_token: std::sync::Arc::new("tok".to_string()),
            disabled: true,
        };
        assert!(write_mcp_config_file(&Uuid::nil(), dir.to_str().unwrap(), &cfg).is_none());
    }

    #[test]
    fn write_mcp_config_file_writes_expected_json() {
        // Lock the config schema so a future refactor can't accidentally
        // change the field names — claude-CLI's --mcp-config parser is
        // strict and a renamed field surfaces as a confusing 'no servers'.
        let dir = tempdir_for_test();
        let cfg = McpInjectConfig {
            base_url: "http://127.0.0.1:3030".to_string(),
            internal_token: std::sync::Arc::new("tok-abc".to_string()),
            disabled: false,
        };
        let id = Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap();
        let path = write_mcp_config_file(&id, dir.to_str().unwrap(), &cfg).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let entry = &parsed["mcpServers"]["neige"];
        assert_eq!(entry["type"], "http");
        assert_eq!(
            entry["url"],
            "http://127.0.0.1:3030/mcp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        );
        assert_eq!(entry["headers"]["Authorization"], "Bearer tok-abc");
    }

    /// Throwaway tempdir for filesystem tests. We don't pull in the
    /// `tempfile` crate just for this — std::env::temp_dir + a uuid name
    /// is sufficient and deterministic enough.
    fn tempdir_for_test() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("neige-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn read_todos_on_missing_file_returns_empty() {
        // First-time read must be empty, not an error — saves every caller
        // from having to special-case "no file yet".
        let dir = tempdir_for_test();
        let todos = read_todos(&Uuid::new_v4(), dir.to_str().unwrap());
        assert!(todos.is_empty());
    }

    #[test]
    fn write_then_read_todos_round_trips() {
        let dir = tempdir_for_test();
        let id = Uuid::new_v4();
        let list = vec![
            Todo {
                id: "t1".to_string(),
                text: "do thing".to_string(),
                status: TodoStatus::Pending,
            },
            Todo {
                id: "t2".to_string(),
                text: "do other".to_string(),
                status: TodoStatus::Completed,
            },
        ];
        write_todos(&id, dir.to_str().unwrap(), &list).unwrap();
        let read_back = read_todos(&id, dir.to_str().unwrap());
        assert_eq!(read_back, list);
    }

    #[test]
    fn write_todos_replaces_wholesale() {
        // Confirm TodoWrite-style replace semantics — second write doesn't
        // append, it overwrites. This is the contract the tool documents.
        let dir = tempdir_for_test();
        let id = Uuid::new_v4();
        let first = vec![Todo {
            id: "a".into(),
            text: "first".into(),
            status: TodoStatus::Pending,
        }];
        let second = vec![Todo {
            id: "b".into(),
            text: "second".into(),
            status: TodoStatus::InProgress,
        }];
        write_todos(&id, dir.to_str().unwrap(), &first).unwrap();
        write_todos(&id, dir.to_str().unwrap(), &second).unwrap();
        assert_eq!(read_todos(&id, dir.to_str().unwrap()), second);
    }

    #[test]
    fn todo_status_serializes_snake_case() {
        // The orchestrator-facing wire shape uses snake_case status values
        // — keep the serde rename in lock-step with the tool docs.
        assert_eq!(
            serde_json::to_string(&TodoStatus::InProgress).unwrap(),
            "\"in_progress\""
        );
        assert_eq!(
            serde_json::to_string(&TodoStatus::Pending).unwrap(),
            "\"pending\""
        );
        assert_eq!(
            serde_json::to_string(&TodoStatus::Completed).unwrap(),
            "\"completed\""
        );
    }

    #[test]
    fn legacy_session_meta_loads_without_parent_id() {
        // Session files written before tasks existed carry no `parent_id`.
        // They must load as root agents rather than failing to parse.
        let json = r#"{"id":"00000000-0000-0000-0000-000000000000","title":"t",
            "program":"claude","cwd":"/tmp","proxy":null,"use_worktree":false,
            "worktree_branch":null,"created_at":"2024-01-01T00:00:00Z",
            "last_active":"2024-01-01T00:00:00Z"}"#;
        let meta: SessionMeta = serde_json::from_str(json).unwrap();
        assert_eq!(meta.parent_id, None);
    }

    #[test]
    fn session_meta_round_trips_parent_id() {
        let parent = Uuid::new_v4();
        let meta = SessionMeta {
            id: Uuid::nil(),
            title: "t".into(),
            program: "claude".into(),
            cwd: "/tmp".into(),
            proxy: None,
            use_worktree: false,
            worktree_branch: None,
            created_at: "2024-01-01T00:00:00Z".into(),
            last_active: "2024-01-01T00:00:00Z".into(),
            parent_id: Some(parent),
            mode: SessionMode::Terminal,
        };
        let s = serde_json::to_string(&meta).unwrap();
        let parsed: SessionMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.parent_id, Some(parent));
    }

    #[test]
    fn root_session_meta_omits_parent_id_field() {
        // Root agents keep the pre-tasks wire shape, so a session file written
        // by this build still parses on a server without the field.
        let meta = SessionMeta {
            id: Uuid::nil(),
            title: "t".into(),
            program: "claude".into(),
            cwd: "/tmp".into(),
            proxy: None,
            use_worktree: false,
            worktree_branch: None,
            created_at: "2024-01-01T00:00:00Z".into(),
            last_active: "2024-01-01T00:00:00Z".into(),
            parent_id: None,
            mode: SessionMode::Terminal,
        };
        let s = serde_json::to_string(&meta).unwrap();
        assert!(!s.contains("parent_id"));
    }

    #[test]
    fn create_conv_request_defaults_parent_id_to_none() {
        let req: CreateConvRequest = serde_json::from_str(r#"{"title":"t"}"#).unwrap();
        assert_eq!(req.parent_id, None);
    }

    #[test]
    fn create_conv_request_accepts_parent_id() {
        let parent = Uuid::new_v4();
        let body = format!(r#"{{"title":"t","parent_id":"{parent}"}}"#);
        let req: CreateConvRequest = serde_json::from_str(&body).unwrap();
        assert_eq!(req.parent_id, Some(parent));
    }

    fn conv_fixture(id: Uuid, parent_id: Option<Uuid>) -> Conversation {
        Conversation {
            id,
            title: "t".into(),
            program: "bash".into(),
            cwd: "/tmp".into(),
            proxy: None,
            use_worktree: false,
            worktree_branch: None,
            parent_id,
            created_at: chrono::Utc::now(),
            mode: SessionMode::Terminal,
            client: None,
            chat_client: None,
            activity: Activity::Unknown,
            activity_set_at: Instant::now(),
        }
    }

    fn manager_with(convs: &[(Uuid, Option<Uuid>)]) -> ConversationManager {
        let dir = tempdir_for_test();
        let mut mgr = ConversationManager::new(dir.to_str().unwrap());
        for (id, parent) in convs {
            mgr.convs.insert(*id, conv_fixture(*id, *parent));
        }
        mgr
    }

    #[test]
    fn validate_parent_rejects_unknown_parent() {
        let mgr = manager_with(&[]);
        let err = mgr.validate_parent(&Uuid::new_v4()).unwrap_err();
        assert!(err.contains("not found"), "unexpected error: {err}");
    }

    #[test]
    fn validate_parent_accepts_a_root_agent() {
        let root = Uuid::new_v4();
        let mgr = manager_with(&[(root, None)]);
        assert!(mgr.validate_parent(&root).is_ok());
    }

    #[test]
    fn validate_parent_rejects_two_level_nesting() {
        // A child agent can't itself become a task root — the sidebar only
        // renders one level of nesting.
        let root = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mgr = manager_with(&[(root, None), (child, Some(root))]);
        let err = mgr.validate_parent(&child).unwrap_err();
        assert!(err.contains("one level"), "unexpected error: {err}");
    }

    #[test]
    fn children_of_returns_only_direct_children() {
        let root = Uuid::new_v4();
        let other_root = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let mgr = manager_with(&[
            (root, None),
            (other_root, None),
            (a, Some(root)),
            (b, Some(root)),
            (foreign, Some(other_root)),
        ]);

        let mut kids = mgr.children_of(&root);
        kids.sort();
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(kids, expected);

        // Asking a child for its children is empty, and an unrelated task's
        // child never leaks in.
        assert!(mgr.children_of(&a).is_empty());
        assert_eq!(mgr.children_of(&other_root), vec![foreign]);
    }

    /// Surviving session ids, sorted so assertions don't depend on HashMap order.
    fn remaining_ids(mgr: &ConversationManager) -> Vec<Uuid> {
        let mut ids: Vec<Uuid> = mgr.convs.keys().copied().collect();
        ids.sort();
        ids
    }

    #[tokio::test]
    async fn remove_task_cascades_to_its_agents() {
        // Guards the cascade wiring itself, not just `children_of`. The
        // fixtures have no daemon behind them, so `kill_session` bails on the
        // missing socket and nothing is spawned or killed for real.
        let root = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let other_root = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let mut mgr = manager_with(&[
            (root, None),
            (a, Some(root)),
            (b, Some(root)),
            (other_root, None),
            (foreign, Some(other_root)),
        ]);

        mgr.remove(&root).await;

        let mut expected = vec![other_root, foreign];
        expected.sort();
        assert_eq!(remaining_ids(&mgr), expected);
    }

    #[tokio::test]
    async fn remove_agent_leaves_its_task_and_siblings() {
        // The cascade only runs downward — deleting one agent must not take
        // its task or the sibling agents with it.
        let root = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut mgr = manager_with(&[(root, None), (a, Some(root)), (b, Some(root))]);

        mgr.remove(&a).await;

        let mut expected = vec![root, b];
        expected.sort();
        assert_eq!(remaining_ids(&mgr), expected);
    }

    #[tokio::test]
    async fn create_rejects_an_agent_nested_under_another_agent() {
        // Covers the `create` → `validate_parent` wiring. Chat mode on a
        // manager with no runner configured is what makes this both safe and
        // load-bearing: the call cannot reach a spawn, and if the parent check
        // ever stops firing the request fails on the missing-runner error
        // instead, so the assertion below still catches it.
        let root = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut mgr = manager_with(&[(root, None), (child, Some(root))]);

        let body = serde_json::json!({
            "title": "x",
            "program": "claude",
            "cwd": "/tmp",
            "proxy": null,
            "use_worktree": false,
            "mode": "chat",
            "name": "nested",
            "parent_id": child,
        });
        let req: CreateConvRequest = serde_json::from_value(body).unwrap();

        let err = mgr.create(req).await.unwrap_err();
        assert!(err.contains("one level"), "unexpected error: {err}");
    }
}
