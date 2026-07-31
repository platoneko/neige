# neige

A web-based terminal session manager for [Claude Code](https://github.com/anthropics/claude-code) and other CLI tools.

Manage multiple Claude Code conversations side-by-side in your browser with drag-and-drop split panes, persistent sessions, and SSH tunnel support.

## Features

- **Multi-session** — Run multiple Claude Code instances simultaneously
- **Split panes** — Drag tabs to split horizontally/vertically (powered by [dockview](https://github.com/mathuo/dockview))
- **Real terminal** — Full PTY passthrough via WebSocket, rendered with [xterm.js](https://xtermjs.org/)
- **Session persistence** — Sessions survive browser refresh; resume detached sessions automatically
- **Worktree support** — Each Claude Code session can run in its own git worktree
- **Directory picker** — Browse and select working directories with autocomplete and git repo detection
- **Proxy support** — Configure HTTP/HTTPS proxy per session, persisted to disk
- **Port forwarding** — Configure port mappings in the web UI, automatically synced to SSH tunnel
- **Remote access** — `neige-connect` CLI tunnels to a remote host; auto-provisions neige if not installed
- **Layout persistence** — Split layout saved to `.neige/layout.json`, config saved to `~/.config/neige/config.json`
- **Token auth** — First-run login URL with fragment-delivered token; session cookie (`HttpOnly; SameSite=Strict`) afterwards
- **Works with any CLI** — Not limited to Claude Code; run `aider`, `gemini`, or any program

## Architecture

```
Browser (React + xterm.js + dockview)
    ↕ WebSocket (raw PTY bytes)
Rust server (axum + portable-pty)
    ↕ PTY
claude / aider / any CLI program
```

The server manages session lifecycle — creating, detaching, resuming, and persisting sessions to `.neige/sessions/`. A separate `neige-connect` CLI provides SSH ControlMaster-based tunneling for remote access, with automatic provisioning.

## Prerequisites

- [Rust](https://rustup.rs/) (1.85+)
- [Node.js](https://nodejs.org/) (20+)

## Quick Start

```bash
# Build frontend
cd web && npm install && npm run build && cd ..

# Build chat runner (required for Chat / Mode B sessions)
cd runners/neige-chat-runner && npm install && npm run build && cd ../..

# Build and run
cargo run
```

On first launch the server prints a one-time login URL to stdout:

```
Open this URL in your browser to sign in:
  http://127.0.0.1:3030/login#token=<…>
```

Open that URL once — the token is delivered via URL fragment (never sent to the server over the wire or written to access logs). After login, an `HttpOnly; SameSite=Strict` session cookie (30-day) is used for subsequent requests.

The hash of the token is persisted at `~/.config/neige/auth.json` (mode `0600`). The plaintext token is shown only once; if you lose it, generate a new one:

```bash
cargo run -- auth rotate   # prints a new token, invalidates all sessions
```

### Binding

Default bind is `127.0.0.1` — LAN peers cannot reach the port directly. To expose over LAN (relying on the token for access control):

```bash
cargo run -- --listen 0.0.0.0
```

For multi-user remote hosts, prefer `neige-connect` over `--listen 0.0.0.0`. Note that TCP loopback is *not* a per-user boundary on shared Linux hosts — other local users can reach `127.0.0.1:3030` too, and only the token stops them.

### Allowed origins

State-changing requests (login, API calls, WebSocket upgrades) are rejected unless their `Origin` header is on an allowlist. Loopback (`localhost`, `127.0.0.1`, `::1`) is always allowed.

If you reach the server via any other hostname — LAN IP, a reverse proxy, a Tailscale MagicDNS name — add it with `--allowed-origin`:

```bash
cargo run -- --listen 0.0.0.0 --allowed-origin http://pivot.tail328551.ts.net --allowed-origin http://192.168.1.10
```

If not listed, the browser login will fail with `403 origin missing and referer not trusted` — even when the token is correct.

**Tailscale is auto-detected.** On startup neige runs `tailscale status --json` against the default daemon socket and adds that node's Tailscale IPs, MagicDNS FQDN, and short hostname to the allowlist (with and without `:<port>`). If `tailscale` isn't installed or returns nothing, this is silently skipped.

**Multiple `tailscaled` instances** (e.g. a second userspace or dual-instance setup) are *not* hard-coded. Point neige at their sockets explicitly:

```bash
# CLI (repeatable)
neige-server --tailscale-socket /run/tailscale-neko/tailscaled.sock \
             --tailscale-socket ~/.config/tailscale-plat/sock

# or env (path-list separator: `:` on Unix, `;` on Windows)
export NEIGE_TAILSCALE_SOCKETS=/run/tailscale-neko/tailscaled.sock:$HOME/.config/tailscale-plat/sock
```

Each extra socket is probed in parallel with the same silent-on-failure rules. Deploy-specific topology stays in the unit / env; the binary only provides the generic hook.

### CLI flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--port <N>` | `3030` | Listen port |
| `--listen <ADDR>` | `127.0.0.1` | Listen address (use `0.0.0.0` for LAN) |
| `--allowed-origin <URL>` | — | Additional allowed Origin (repeatable); loopback is always allowed |
| `--allowed-cidr <CIDR>` | — | Trust any http(s) origin whose host is an IP in this CIDR (repeatable) |
| `--tailscale-socket <PATH>` | — | Extra Tailscale daemon socket to probe for origins (repeatable); also `NEIGE_TAILSCALE_SOCKETS` |
| `--no-auth` | off | Disable auth entirely (DEV ONLY, forces `--listen 127.0.0.1`) |
| `--auth-file <PATH>` | `~/.config/neige/auth.json` | Override auth file location |

## Development

```bash
# One-time / after runner changes: build the chat runner used by Chat (Mode B)
cd runners/neige-chat-runner && npm install && npm run build && cd ../..

# Terminal 1: Rust backend on :3030
cargo run

# Terminal 2: Frontend dev server (with hot reload + API proxy)
cd web && npm run dev
```

Dev server runs on `http://localhost:5173` with API and WebSocket traffic proxied to the backend on `:3030`. For faster iteration during frontend work, pass `--no-auth` to the backend.

Chat sessions use the Node sidecar at `runners/neige-chat-runner/dist/cli.js`. The server resolves it automatically from the workspace when running via `cargo run`; set `NEIGE_RUNNER_PATH=/path/to/cli.js` only if you want to point at a different build.

## Remote Access

Use `neige-connect` to connect to a remote host. If neige isn't running there, it will automatically clone, build, and start it.

```bash
# Connect to remote host (auto-provisions if needed)
neige-connect myserver

# Custom local port
neige-connect myserver -l 8080

# Specify remote working directory
neige-connect myserver -d ~/projects

# Skip auto-provisioning
neige-connect myserver --no-provision
```

Port mappings are configured in the web UI and automatically synced to the SSH tunnel.

> **Auth note:** the SSH tunnel forwards `localhost:<local>` on your machine to `localhost:<remote>` on the target. Since the server requires a token, you need to open the remote-printed login URL once. `neige-connect` does not yet automate token retrieval — SSH into the host and either run `neige-server auth rotate` or check `~/.config/neige/auth.json` was already set up by a prior direct login.

## Project Structure

```
neige/
├── crates/
│   ├── neige-server/             # Main backend
│   │   └── src/
│   │       ├── main.rs           # axum server, CLI, auth wiring
│   │       ├── api/mod.rs        # REST + WebSocket routes + SSRF blocklist
│   │       ├── auth/             # Token, session cookie, Origin check, login page
│   │       ├── conversation/     # Session manager + persistence
│   │       └── pty/              # PTY wrapper (portable-pty)
│   └── neige-connect/            # Remote access CLI with auto-provisioning
│       └── src/main.rs
└── web/                          # React + Vite frontend
    └── src/
        ├── App.tsx
        ├── components/
        │   ├── Sidebar.tsx           # Collapsible session list
        │   ├── PortForwardPanel.tsx   # Port forwarding config
        │   ├── TerminalPanel.tsx      # Dockview-based split terminal
        │   ├── CreateDialog.tsx       # New session dialog
        │   └── ConfirmDialog.tsx      # Confirmation modal
        └── hooks/
            ├── useTerminal.ts         # xterm.js + WebSocket hook
            ├── useConversations.ts    # Session CRUD + polling
            └── useConfig.ts           # Config persistence
```

## License

MIT
