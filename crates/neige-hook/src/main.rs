//! `neige-hook` — the Claude Code hook shim.
//!
//! Registered as the command for every event in neige-server's
//! `activity::HOOK_BINDINGS`. Reads the hook payload on stdin and forwards it
//! verbatim to `POST /api/hooks/<session_id>`; the server reads the event name
//! out of the payload's own `hook_event_name`, so this binary never needs to
//! know which hook invoked it.
//!
//! Two rules govern everything here:
//!
//!   * **Never fail the hook.** Every path exits 0 and writes nothing to
//!     stdout, which Claude Code reads as "no override, carry on". Diagnostics
//!     go to stderr. A shim that errors, blocks, or prints stray output stalls
//!     or confuses the agent, and a status dot is never worth that.
//!   * **Stay silent outside neige.** The hooks are installed user-globally so
//!     that a `claude` the user types by hand inside a neige terminal is still
//!     seen. A claude started anywhere else inherits no `NEIGE_SESSION_ID` and
//!     must do nothing at all.
//!
//! Env contract, set by neige-server on the session's process (see
//! `conversation::session_env`):
//!   * `NEIGE_SESSION_ID`  — neige session uuid. Absent ⇒ no-op.
//!   * `NEIGE_SERVER_URL`  — e.g. `http://127.0.0.1:7777`.
//!   * `NEIGE_HOOK_TOKEN`  — server's internal bearer token; absent when the
//!     server runs with auth disabled.

use std::io::Read;
use std::time::Duration;

/// Long enough to ride out a busy server, short enough that a wedged one
/// costs the agent a bounded pause instead of a hang.
const POST_TIMEOUT: Duration = Duration::from_secs(3);

fn main() {
    if let Err(e) = forward() {
        eprintln!("neige-hook: {e}");
    }
}

fn forward() -> Result<(), String> {
    // Not running under neige — the overwhelmingly common case for a
    // user-global hook install. Return before touching stdin so we don't
    // consume the payload of a hook we have no business handling.
    let Some(session_id) = non_empty_var("NEIGE_SESSION_ID") else {
        return Ok(());
    };
    let base_url = non_empty_var("NEIGE_SERVER_URL")
        .ok_or("NEIGE_SESSION_ID is set but NEIGE_SERVER_URL is not")?;

    let mut payload = String::new();
    std::io::stdin()
        .read_to_string(&mut payload)
        .map_err(|e| format!("reading hook payload: {e}"))?;

    let url = format!(
        "{}/api/hooks/{}",
        base_url.trim_end_matches('/'),
        session_id
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(POST_TIMEOUT)
        .build()
        .map_err(|e| format!("building client: {e}"))?;
    // neige's CSRF guard rejects a state-changing request that carries
    // neither `Origin` nor `Referer`, which is what a plain POST from a
    // non-browser looks like. `base_url` is the server's own loopback
    // address, and loopback origins are unconditionally allowed — so
    // declaring it truthfully passes the check without punching a hole for
    // real browsers, which cannot forge this header.
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .header("origin", &base_url)
        .body(payload);
    if let Some(token) = non_empty_var("NEIGE_HOOK_TOKEN") {
        req = req.bearer_auth(token);
    }
    let res = req.send().map_err(|e| format!("posting to {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url} returned {}", res.status()));
    }
    Ok(())
}

/// Treats an empty value the same as an unset one — an exported-but-empty
/// `NEIGE_SESSION_ID` means "no session", not "session named empty string".
fn non_empty_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}
