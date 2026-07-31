mod activity;
mod api;
mod attach;
mod auth;
mod conversation;
mod mcp;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use clap::{Parser, Subcommand};
use tower_http::services::ServeDir;

/// Decide the Cache-Control header for a given URL path.
///
/// Content-hashed `assets/*` chunks are safe to cache forever. Everything
/// else (index.html, manifest, favicon, API responses) must revalidate so
/// a fresh deploy doesn't strand the user on a stale index.html that
/// points at chunks that no longer exist on disk — that's what causes
/// "blank page after deploy" on iOS Safari.
fn cache_control_for(path: &str) -> &'static str {
    if path.contains("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache, must-revalidate"
    }
}

async fn cache_control_layer(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path().to_string();
    let mut response = next.run(req).await;
    if let Ok(v) = cache_control_for(&path).parse() {
        response
            .headers_mut()
            .insert(axum::http::header::CACHE_CONTROL, v);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn cache_control_for_assets_is_immutable() {
        assert_eq!(
            cache_control_for("/assets/index-abc123.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control_for("/m/assets/index-COnEAKR4.css"),
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn cache_control_for_html_must_revalidate() {
        // index.html, manifest, favicon, API responses — all revalidated
        // so a deploy with new chunk hashes doesn't strand stale clients.
        for p in [
            "/",
            "/m/",
            "/index.html",
            "/m/index.html",
            "/favicon.svg",
            "/m/manifest.webmanifest",
            "/api/conversations",
            "/api/healthz",
        ] {
            assert_eq!(cache_control_for(p), "no-cache, must-revalidate", "{p}");
        }
    }

    #[test]
    fn cache_control_assets_anywhere_in_path() {
        // The substring check is intentional — assets directory may be
        // nested under any base (web/dist/assets, m/assets, etc).
        assert_eq!(
            cache_control_for("/some/nested/assets/foo.css"),
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn collect_tailscale_sockets_always_includes_default() {
        let got = collect_tailscale_sockets(&[], None);
        assert_eq!(got, vec![None]);
    }

    #[test]
    fn collect_tailscale_sockets_merges_cli_and_env_deduped() {
        let cli = vec![
            PathBuf::from("/run/tailscale-neko/tailscaled.sock"),
            PathBuf::from("/run/a.sock"),
        ];
        // env uses the platform path-list separator via join_paths
        let env = std::env::join_paths([
            PathBuf::from("/run/a.sock"), // dup of cli
            PathBuf::from("/home/me/.config/tailscale-plat/sock"),
        ])
        .unwrap();
        let env_str = env.to_string_lossy();
        let got = collect_tailscale_sockets(&cli, Some(&env_str));
        assert_eq!(
            got,
            vec![
                None,
                Some(PathBuf::from("/run/tailscale-neko/tailscaled.sock")),
                Some(PathBuf::from("/run/a.sock")),
                Some(PathBuf::from("/home/me/.config/tailscale-plat/sock")),
            ]
        );
    }

    #[test]
    fn origins_from_status_json_ips_dns_hostname() {
        let json = serde_json::json!({
            "Self": {
                "TailscaleIPs": ["100.93.210.104", "fd7a:115c:a1e0::bb34:d269"],
                "DNSName": "pivot-home.tail090ab2.ts.net.",
                "HostName": "pivot-home"
            }
        });
        let got = origins_from_tailscale_status_json(&json, 3131);
        assert!(got.contains(&"http://100.93.210.104".into()));
        assert!(got.contains(&"http://100.93.210.104:3131".into()));
        assert!(got.contains(&"http://[fd7a:115c:a1e0::bb34:d269]".into()));
        assert!(got.contains(&"http://[fd7a:115c:a1e0::bb34:d269]:3131".into()));
        assert!(got.contains(&"http://pivot-home.tail090ab2.ts.net".into()));
        assert!(got.contains(&"http://pivot-home.tail090ab2.ts.net:3131".into()));
        assert!(got.contains(&"http://pivot-home".into()));
        assert!(got.contains(&"http://pivot-home:3131".into()));
    }

    #[test]
    fn origins_from_status_json_empty_self() {
        let json = serde_json::json!({"Self": {}});
        assert!(origins_from_tailscale_status_json(&json, 3030).is_empty());
    }
}

#[derive(Parser)]
#[command(name = "neige-server", about = "Web-based terminal session manager")]
struct Cli {
    /// Port to listen on
    #[arg(long, default_value = "3030")]
    port: u16,

    /// Listen address. Defaults to 127.0.0.1 to avoid LAN exposure.
    #[arg(long, default_value = "127.0.0.1")]
    listen: String,

    /// Path to web/dist directory (auto-detected if not set)
    #[arg(long)]
    static_dir: Option<String>,

    /// Path to web-mobile/dist directory (auto-detected if not set)
    #[arg(long)]
    mobile_static_dir: Option<String>,

    /// Additional allowed Origin (e.g. https://neige.example.com). Can be repeated.
    #[arg(long = "allowed-origin")]
    allowed_origins: Vec<String>,

    /// Trust any http(s) origin whose host IP is in this CIDR block (e.g.
    /// 10.8.0.0/24 for a WireGuard subnet), so the whole subnet passes the
    /// origin check without listing each host. Can be repeated.
    #[arg(long = "allowed-cidr")]
    allowed_cidrs: Vec<String>,

    /// Extra Tailscale daemon socket to probe for auto-detected origins
    /// (in addition to the default `tailscale` socket). Use when multiple
    /// `tailscaled` instances share the host. Can be repeated. Also accepts
    /// `NEIGE_TAILSCALE_SOCKETS` (path-list separator, e.g. `:` on Unix).
    #[arg(long = "tailscale-socket", value_name = "PATH")]
    tailscale_sockets: Vec<std::path::PathBuf>,

    /// Disable authentication entirely (DEV ONLY — forces --listen 127.0.0.1)
    #[arg(long)]
    no_auth: bool,

    /// Path to auth file override
    #[arg(long)]
    auth_file: Option<String>,

    /// Disable auto-injection of an `--mcp-config` flag into chat-mode
    /// claude subprocesses. Default: injected, so the inner claude can call
    /// neige's HTTP MCP to drive sibling sessions and read its own log.
    #[arg(long)]
    no_mcp_inject: bool,

    #[command(subcommand)]
    cmd: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Auth management
    Auth {
        #[command(subcommand)]
        cmd: AuthCmd,
    },
    /// Claude Code lifecycle hooks, which drive each session's activity dot
    Hooks {
        #[command(subcommand)]
        cmd: HooksCmd,
    },
}

#[derive(Subcommand)]
enum HooksCmd {
    /// Merge neige's hooks into ~/.claude/settings.json. Needed once per
    /// machine; installing globally is what lets neige see a `claude` you
    /// start by hand at a shell prompt, not just the ones it spawns.
    Install {
        /// Path to the neige-hook binary (defaults to alongside this one)
        #[arg(long)]
        shim_path: Option<String>,
    },
    /// Remove neige's hooks from ~/.claude/settings.json, leaving any hooks
    /// you configured yourself untouched.
    Uninstall {
        #[arg(long)]
        shim_path: Option<String>,
    },
}

#[derive(Subcommand)]
enum AuthCmd {
    /// Rotate the token (generates a new one, invalidates all existing sessions)
    Rotate,
    /// Print the current login URL. Requires a new token to be generated if
    /// the auth file already exists (plaintext token is never stored).
    PrintUrl {
        /// Base URL to print (e.g. http://127.0.0.1:3030)
        #[arg(long, default_value = "http://127.0.0.1:3030")]
        bind: String,
    },
}

/// Run `hooks install` / `hooks uninstall`, exiting non-zero on failure so a
/// setup script notices. Both directions share the path resolution and the
/// reporting; only the verb differs.
fn run_hooks_command(shim_path: Option<&str>, install: bool) {
    let resolved = shim_path
        .map(|p| Ok(std::path::PathBuf::from(p)))
        .unwrap_or_else(activity::install::default_shim_path);
    let (shim, settings) = match (resolved, activity::install::settings_path()) {
        (Ok(shim), Ok(settings)) => (shim, settings),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let result = if install {
        activity::install::install(&settings, &shim)
    } else {
        activity::install::uninstall(&settings, &shim)
    };
    match result {
        Ok(()) if install => {
            println!("Installed neige hooks into {}", settings.display());
            println!("  shim: {}", shim.display());
            println!();
            println!("Claude sessions started from now on report their activity to neige.");
        }
        Ok(()) => println!("Removed neige hooks from {}", settings.display()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

fn resolve_dist_dir(cli_path: Option<&str>, subdir: &str) -> std::path::PathBuf {
    if let Some(p) = cli_path {
        return std::path::PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let workspace = bin_dir.parent().and_then(|p| p.parent());
            if let Some(ws) = workspace {
                let candidate = ws.join(subdir);
                if candidate.exists() {
                    return candidate;
                }
            }
        }
    }
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let workspace_dir = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    workspace_dir.join(subdir)
}

fn resolve_static_dir(cli_path: Option<&str>) -> std::path::PathBuf {
    resolve_dist_dir(cli_path, "web/dist")
}

fn resolve_mobile_static_dir(cli_path: Option<&str>) -> std::path::PathBuf {
    resolve_dist_dir(cli_path, "web-mobile/dist")
}

fn auth_file_path_from(cli_override: Option<&str>) -> std::path::PathBuf {
    cli_override
        .map(std::path::PathBuf::from)
        .unwrap_or_else(auth::auth_file_path)
}

/// Either load an existing auth file or generate a fresh token and persist its hash.
/// Returns (hash, freshly_generated_token_if_any).
fn ensure_token(path: &std::path::Path) -> std::io::Result<(String, Option<String>)> {
    if let Some(existing) = auth::load_auth_file(path)? {
        return Ok((existing.token_hash, None));
    }
    let token = auth::generate_token();
    let hash = auth::hash_token(&token);
    let file = auth::AuthFile::new(hash.clone());
    auth::save_auth_file(path, &file)?;
    Ok((hash, Some(token)))
}

/// Write the provided plaintext password's hash into the auth file if it's
/// missing or differs from the existing hash. No-op when the stored hash
/// already matches — keeps startup idempotent across repeated runs with the
/// same NEIGE_PASSWORD.
fn apply_password(path: &std::path::Path, password: &str) -> std::io::Result<()> {
    let hash = auth::hash_token(password);
    let existing = auth::load_auth_file(path)?;
    let up_to_date = existing.as_ref().map(|f| f.token_hash == hash).unwrap_or(false);
    if up_to_date {
        println!("NEIGE_PASSWORD matches existing auth file.");
        return Ok(());
    }
    let file = auth::AuthFile::new(hash);
    auth::save_auth_file(path, &file)?;
    println!("NEIGE_PASSWORD written to {}.", path.display());
    Ok(())
}

fn rotate_token(path: &std::path::Path) -> std::io::Result<String> {
    let token = auth::generate_token();
    let hash = auth::hash_token(&token);
    let mut file = auth::AuthFile::new(hash);
    file.rotated_at = Some(chrono::Utc::now());
    auth::save_auth_file(path, &file)?;
    Ok(token)
}

/// Build the list of Tailscale sockets to probe: always the default daemon
/// (`None` → CLI uses its built-in socket), then extra paths from CLI flags
/// and `NEIGE_TAILSCALE_SOCKETS`. Duplicates are dropped, order preserved.
fn collect_tailscale_sockets(
    cli_sockets: &[std::path::PathBuf],
    env_sockets: Option<&str>,
) -> Vec<Option<std::path::PathBuf>> {
    let mut out: Vec<Option<std::path::PathBuf>> = vec![None];
    let mut seen = std::collections::HashSet::new();

    let mut push_path = |p: std::path::PathBuf| {
        if p.as_os_str().is_empty() {
            return;
        }
        if seen.insert(p.clone()) {
            out.push(Some(p));
        }
    };

    for p in cli_sockets {
        push_path(p.clone());
    }
    if let Some(env) = env_sockets {
        for p in std::env::split_paths(env) {
            push_path(p);
        }
    }
    out
}

/// Parse `tailscale status --json` Self identities into origin URLs (with and
/// without `:<port>`). Pure helper so unit tests don't need a live daemon.
fn origins_from_tailscale_status_json(json: &serde_json::Value, port: u16) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    if let Some(ips) = json.pointer("/Self/TailscaleIPs").and_then(|v| v.as_array()) {
        for ip in ips.iter().filter_map(|v| v.as_str()) {
            hosts.push(if ip.contains(':') {
                format!("[{ip}]")
            } else {
                ip.to_string()
            });
        }
    }
    if let Some(dns) = json.pointer("/Self/DNSName").and_then(|v| v.as_str()) {
        let fqdn = dns.trim_end_matches('.');
        if !fqdn.is_empty() {
            hosts.push(fqdn.to_string());
        }
    }
    if let Some(short) = json.pointer("/Self/HostName").and_then(|v| v.as_str()) {
        if !short.is_empty() {
            hosts.push(short.to_string());
        }
    }

    let mut origins = Vec::with_capacity(hosts.len() * 2);
    for h in hosts {
        origins.push(format!("http://{h}"));
        origins.push(format!("http://{h}:{port}"));
    }
    origins
}

/// One socket probe: `tailscale [--socket PATH] status --json`, 800ms timeout.
/// Missing binary, dead socket, timeout, or bad JSON → empty (silent).
async fn query_tailscale_status_json(socket: Option<&std::path::Path>) -> Option<serde_json::Value> {
    let mut cmd = tokio::process::Command::new("tailscale");
    if let Some(path) = socket {
        cmd.arg("--socket").arg(path);
    }
    cmd.args(["status", "--json"]);

    let output_res = tokio::time::timeout(
        std::time::Duration::from_millis(800),
        cmd.output(),
    )
    .await;

    let output = match output_res {
        Ok(Ok(o)) if o.status.success() => o,
        _ => return None,
    };
    serde_json::from_slice(&output.stdout).ok()
}

/// Shell out to `tailscale status --json` on each candidate socket and
/// synthesize origin URLs for that node's identities (IPs, MagicDNS FQDN,
/// short hostname), each with and without `:<port>`. Always probes the
/// default socket; extra sockets come from `--tailscale-socket` /
/// `NEIGE_TAILSCALE_SOCKETS`. Silent no-op per socket if missing or slow.
async fn detect_tailscale_origins(
    port: u16,
    extra_sockets: &[std::path::PathBuf],
) -> Vec<String> {
    let env_sockets = std::env::var("NEIGE_TAILSCALE_SOCKETS").ok();
    let sockets = collect_tailscale_sockets(extra_sockets, env_sockets.as_deref());

    let futs = sockets.into_iter().map(|sock| async move {
        let json = query_tailscale_status_json(sock.as_deref()).await?;
        Some(origins_from_tailscale_status_json(&json, port))
    });
    let results = futures::future::join_all(futs).await;

    let mut origins = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for batch in results.into_iter().flatten() {
        for o in batch {
            if seen.insert(o.clone()) {
                origins.push(o);
            }
        }
    }
    origins
}

fn print_login_url(bind: &str, token: &str) {
    println!();
    println!("Open this URL in your browser to sign in:");
    println!("  {}/login#token={}", bind.trim_end_matches('/'), token);
    println!();
    println!("(Token will only be shown once. To get a new one, run: neige-server auth rotate)");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();
    let cli_password = std::env::var("NEIGE_PASSWORD")
        .ok()
        .filter(|s| !s.is_empty());

    // Subcommand handling (no server start)
    if let Some(cmd) = &cli.cmd {
        match cmd {
            Command::Auth { cmd } => match cmd {
                AuthCmd::Rotate => {
                    let path = auth_file_path_from(cli.auth_file.as_deref());
                    match rotate_token(&path) {
                        Ok(token) => {
                            println!("Token rotated. New token:");
                            println!();
                            println!("  {token}");
                            println!();
                            println!("All existing sessions are invalidated.");
                        }
                        Err(e) => {
                            eprintln!("Failed to rotate token: {e}");
                            std::process::exit(1);
                        }
                    }
                    return;
                }
                AuthCmd::PrintUrl { bind } => {
                    eprintln!(
                        "Note: plaintext tokens are not stored. To obtain a fresh login URL, run:"
                    );
                    eprintln!("  neige-server auth rotate");
                    eprintln!("then format the URL as: {bind}/login#token=<TOKEN>");
                    std::process::exit(2);
                }
            },
            Command::Hooks { cmd } => {
                let (shim_path, install) = match cmd {
                    HooksCmd::Install { shim_path } => (shim_path, true),
                    HooksCmd::Uninstall { shim_path } => (shim_path, false),
                };
                run_hooks_command(shim_path.as_deref(), install);
                return;
            }
        }
    }

    // Safety: disallow publicly binding with auth off.
    if cli.no_auth && cli.listen != "127.0.0.1" && cli.listen != "::1" && cli.listen != "localhost"
    {
        eprintln!(
            "Refusing to start: --no-auth requires --listen 127.0.0.1 (got: {})",
            cli.listen
        );
        std::process::exit(1);
    }
    if cli.no_auth {
        eprintln!("WARNING: auth is DISABLED (--no-auth). Use only for local development.");
        if cli_password.is_some() {
            eprintln!("Refusing to start: NEIGE_PASSWORD has no meaning with --no-auth.");
            std::process::exit(1);
        }
    }

    // Each session is supervised by a neige-session-daemon in its own
    // process; daemons survive neige-server restarts as long as the systemd
    // unit is configured with KillMode=process.

    let project_cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Merge CLI-supplied origins with any we can auto-detect from local
    // Tailscale daemon(s). Users on tailnets otherwise hit a 403 on any
    // non-loopback access. Default socket is always probed; extra instances
    // are opt-in via --tailscale-socket / NEIGE_TAILSCALE_SOCKETS.
    let mut allowed_origins = cli.allowed_origins.clone();
    let ts_origins = detect_tailscale_origins(cli.port, &cli.tailscale_sockets).await;
    if !ts_origins.is_empty() {
        eprintln!("Detected Tailscale origins: {}", ts_origins.join(", "));
        allowed_origins.extend(ts_origins);
    }

    // Internal MCP token, generated fresh on every startup. Used only for
    // server-spawned chat sessions to dial back into neige's HTTP MCP. Not
    // persisted (the previous token is invalidated whenever neige-server
    // restarts — which is fine, sessions get a fresh `--mcp-config` on
    // resume anyway).
    let internal_token = Arc::new(auth::generate_token());

    // Initialize auth state
    let auth_cfg = if cli.no_auth {
        auth::AuthConfig {
            sessions: Arc::new(auth::SessionStore::new()),
            rate_limiter: Arc::new(auth::LoginRateLimiter::new()),
            token_hash: None,
            allowed_origins: allowed_origins.clone(),
            allowed_cidrs: cli.allowed_cidrs.clone(),
            internal_token: internal_token.clone(),
        }
    } else {
        let path = auth_file_path_from(cli.auth_file.as_deref());
        if let Some(pw) = cli_password.as_deref() {
            if let Err(e) = apply_password(&path, pw) {
                eprintln!("Failed to apply password: {e}");
                std::process::exit(1);
            }
        }
        let (hash, fresh_token) = match ensure_token(&path) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("Failed to initialize auth: {e}");
                std::process::exit(1);
            }
        };
        if let Some(tok) = fresh_token {
            let bind = if cli.listen == "0.0.0.0" {
                format!("http://127.0.0.1:{}", cli.port)
            } else {
                format!("http://{}:{}", cli.listen, cli.port)
            };
            print_login_url(&bind, &tok);
        } else if cli_password.is_some() {
            println!();
        } else {
            println!();
            println!(
                "Auth file loaded from {}. Token already exists (only the hash is stored).",
                path.display()
            );
            println!("If you lost the token, run: neige-server auth rotate");
            println!();
        }
        auth::AuthConfig {
            sessions: Arc::new(auth::SessionStore::new()),
            rate_limiter: Arc::new(auth::LoginRateLimiter::new()),
            token_hash: Some(hash),
            allowed_origins,
            allowed_cidrs: cli.allowed_cidrs.clone(),
            internal_token: internal_token.clone(),
        }
    };

    let mcp_inject = Some(conversation::McpInjectConfig::loopback(
        cli.port,
        internal_token.clone(),
        cli.no_mcp_inject,
    ));
    // Resolve the chat-mode runner CLI once at startup so every chat
    // session create / resume sees the same path. NEIGE_RUNNER_PATH wins
    // over the workspace fallback; see `resolve_runner_path` for the full
    // resolution order.
    let runner_path = conversation::resolve_runner_path();
    tracing::info!(path = %runner_path.display(), "chat runner path resolved");
    let runner = Some(conversation::RunnerConfig {
        path: runner_path,
    });
    let state = api::AppState {
        manager: conversation::new_shared_manager_with_config(
            &project_cwd,
            mcp_inject,
            runner,
        ),
        auth: auth_cfg.clone(),
        pending_questions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    };

    let static_dir = resolve_static_dir(cli.static_dir.as_deref());
    let mobile_static_dir = resolve_mobile_static_dir(cli.mobile_static_dir.as_deref());

    // All routes share AppState; AuthConfig is extracted via FromRef<AppState>.
    let public: Router<api::AppState> = Router::new()
        .route("/login", get(auth::routes::login_page))
        .route("/login/submit", post(auth::routes::login_submit))
        .route("/api/auth/logout", post(auth::routes::logout))
        .route("/api/auth/whoami", get(auth::routes::whoami));

    let app = Router::new()
        .merge(public)
        .merge(api::router())
        .merge(mcp::router())
        .nest_service("/m", ServeDir::new(&mobile_static_dir))
        .fallback_service(ServeDir::new(&static_dir))
        .layer(axum::middleware::from_fn_with_state(
            auth_cfg.clone(),
            auth::auth_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            auth_cfg.clone(),
            auth::origin_check_middleware,
        ))
        .layer(axum::middleware::from_fn(cache_control_layer))
        .with_state(state);

    let addr = format!("{}:{}", cli.listen, cli.port);
    println!("neige listening on http://{}", addr);
    println!("project dir: {project_cwd}");
    println!("static dir: {}", static_dir.display());
    println!("mobile static dir: {}", mobile_static_dir.display());
    if cli.listen == "0.0.0.0" {
        eprintln!(
            "WARNING: listening on 0.0.0.0 — anyone who can reach this port can attempt login."
        );
    }

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap();
}
