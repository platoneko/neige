//! Daemon lifecycle for the neige-session backend.
//!
//! Each session is one `neige-session-daemon` process listening on a
//! per-session Unix socket. The daemon is spawned as a normal child of
//! neige-server but its cgroup membership is controlled by the systemd unit
//! — set `KillMode=process` on neige.service so that daemons survive a
//! `systemctl restart`, matching tmux's old "sessions outlive neige-server"
//! property.
//!
//! Socket convention: `$XDG_RUNTIME_DIR/neige/<uuid>.sock`, falling back to
//! `/tmp/neige-<uid>/<uuid>.sock` when XDG_RUNTIME_DIR isn't set (old-school
//! Linux, containers without a user session).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::process::Command;
use uuid::Uuid;

use neige_session::{ClientMsg, write_frame};

/// Compute the socket path for a given session id. Callers don't need to
/// create the parent dir; [`create_session`] handles that.
pub fn sock_path(id: &Uuid) -> PathBuf {
    let base = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // SAFETY: getuid is always safe on Unix.
            let uid = unsafe { libc::getuid() };
            PathBuf::from(format!("/tmp/neige-{uid}"))
        });
    base.join("neige").join(format!("{id}.sock"))
}

/// A daemon for `id` is reachable (socket bound + accepting).
pub async fn is_alive(id: &Uuid) -> bool {
    UnixStream::connect(sock_path(id)).await.is_ok()
}

/// Resolve the daemon binary. Prefer a sibling of the running neige-server
/// (so `cargo run` / `target/release` setups work without any install step);
/// fall back to $PATH.
fn daemon_binary_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("neige-session-daemon");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("neige-session-daemon")
}

/// Read the `NEIGE_TIE_TO_PARENT` env var. Truthy values `1` / `true` /
/// `yes` (case-insensitive) enable the daemon's `--tie-to-parent` flag,
/// which installs `PR_SET_PDEATHSIG(SIGTERM)` so daemons die with the
/// server instead of accumulating as orphans across restarts.
fn tie_to_parent_enabled() -> bool {
    matches!(
        std::env::var("NEIGE_TIE_TO_PARENT")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    )
}

/// Make a child process's environment suitable for an interactive color TTY.
///
/// Clears agent/CI color suppressors that neige-server may have inherited
/// (`NO_COLOR`, `CLICOLOR=0`, `FORCE_COLOR=0`, `TERM=dumb`) and installs a
/// 256-color + truecolor capability pair that xterm.js can render.
fn apply_interactive_term_env(cmd: &mut Command) {
    for key in [
        "NO_COLOR",
        "CLICOLOR",
        "CLICOLOR_FORCE",
        "FORCE_COLOR",
        // Some runners also pin these; leave real TERM handling to the
        // values we set below rather than inheriting `dumb`.
    ] {
        cmd.env_remove(key);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Positive force flags for tools that ignore TERM and only look at these
    // (node chalk, many Rust CLIs, macOS CLICOLOR_FORCE).
    cmd.env("FORCE_COLOR", "1");
    cmd.env("CLICOLOR", "1");
    cmd.env("CLICOLOR_FORCE", "1");
}

/// Ensure a daemon is running for `id`. Idempotent: if one is already live,
/// `program` / `cwd` / `env` are ignored and the caller just reattaches.
/// Returns `Ok(true)` when a fresh daemon was spawned.
pub async fn create_session(
    id: &Uuid,
    program: &str,
    cwd: &str,
    env: &[(String, String)],
) -> Result<bool, String> {
    spawn_daemon(
        id,
        cwd,
        env,
        &["--cwd", cwd, "--", "/bin/sh", "-c", program],
    )
    .await
}

/// Chat-mode variant of `create_session`.
///
/// `runner_args` is the daemon flag list returned by
/// `crate::conversation::build_runner_args` — `--runner-path`, `--cwd`,
/// optional `--resume`, optional `--mcp-config`, optional `--program`.
/// The session uuid is delivered to the daemon via the pre-existing
/// `--id` flag (added by `spawn_daemon`); the daemon then constructs
/// `--session-id` for the runner internally. The daemon itself spawns
/// `node <runner-path>` under piped stdio per these flags; we no longer
/// hand it a trailing `-- claude ...` cmd to exec.
pub async fn create_chat_session(
    id: &Uuid,
    runner_args: &[String],
    cwd: &str,
    env: &[(String, String)],
) -> Result<bool, String> {
    if runner_args.is_empty() {
        return Err("create_chat_session: runner_args is empty".to_string());
    }
    let mut tail: Vec<&str> = vec!["--mode", "chat"];
    for a in runner_args {
        tail.push(a.as_str());
    }
    spawn_daemon(id, cwd, env, &tail).await
}

/// Common spawn path. `tail` is the daemon argv after `--id/--sock`,
/// including `--mode` (in chat mode), `--cwd <path>`, and any mode-specific
/// flags (`--runner-path`, `--mcp-config`, `--resume`, `--program` in chat
/// mode; the trailing `-- /bin/sh -c <cmd>` block in terminal mode). The
/// chat-mode `--cwd` ships in the runner-args list so it lines up with the
/// other runner flags in process listings; the terminal-mode `--cwd` ships
/// in the tail next to the program. Either way, the daemon CLI parses
/// `--cwd` itself — `spawn_daemon` no longer adds it.
async fn spawn_daemon(
    id: &Uuid,
    _cwd: &str,
    env: &[(String, String)],
    tail: &[&str],
) -> Result<bool, String> {
    if is_alive(id).await {
        return Ok(false);
    }

    let sock = sock_path(id);
    if let Some(parent) = sock.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir sock parent: {e}"))?;
    }
    if sock.exists() {
        let _ = std::fs::remove_file(&sock);
    }

    let daemon_bin = daemon_binary_path();
    let mut cmd = Command::new(&daemon_bin);
    cmd.args(["--id", &id.to_string()]);
    cmd.args(["--sock", &sock.to_string_lossy()]);
    // Opt-in: tie daemon lifetime to neige-server via PR_SET_PDEATHSIG on
    // the daemon side. Dev-mode knob so restarts don't leak orphan daemons;
    // prod keeps the default "survive systemctl restart" behaviour.
    if tie_to_parent_enabled() {
        cmd.arg("--tie-to-parent");
    }
    cmd.args(tail);
    // Sessions are interactive PTYs. neige-server itself is often launched
    // from an agent shell (Grok/Claude/CI) that exports NO_COLOR=1,
    // CLICOLOR=0, FORCE_COLOR=0, TERM=dumb so *its* stdout stays plain.
    // Those vars inherit into the daemon → PTY child and silence colors in
    // every TUI (Grok, claude, ls, …). Scrub them and force a color-capable
    // terminal before applying the per-session env overrides.
    apply_interactive_term_env(&mut cmd);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);

    let mut child = cmd.spawn().map_err(|e| format!("spawn daemon: {e}"))?;
    let daemon_pid = child.id();
    tracing::info!(pid = ?daemon_pid, id = %id, "spawned neige-session-daemon");

    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    for _ in 0..75 {
        if is_alive(id).await {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    Err(format!("daemon for {id} did not become ready"))
}

/// Best-effort kill. Opens the daemon's socket, sends Attach (required first
/// frame) then Kill, and drops. The daemon SIGHUPs the child; the child exit
/// tears down the daemon.
pub async fn kill_session(id: &Uuid) {
    let Ok(sock) = UnixStream::connect(sock_path(id)).await else {
        // Already gone.
        return;
    };
    let (_, mut wr) = sock.into_split();
    let _ = write_frame(&mut wr, &ClientMsg::Attach { cols: 80, rows: 24 }).await;
    let _ = write_frame(&mut wr, &ClientMsg::Kill).await;
    // Give the kernel a beat to flush the bytes before we drop `wr`; some
    // runtimes race the FIN ahead of tiny pending writes. Cheap insurance.
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(wr);
    tracing::debug!("sent Kill to session daemon {id}");
}
