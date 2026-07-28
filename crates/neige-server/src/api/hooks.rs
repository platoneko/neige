//! Claude Code lifecycle hook ingest.
//!
//! The `neige-hook` shim runs as a hook command inside every Claude Code
//! process that inherits `NEIGE_SESSION_ID` from its session's PTY, and POSTs
//! the raw hook payload here. We read the event name out of the payload and
//! project it onto the session's [`Activity`].
//!
//! The route sits under `/api/` so the auth middleware answers an
//! unauthenticated POST with 401 rather than a redirect to the login page.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::Value;
use uuid::Uuid;

use super::AppState;
use crate::activity::activity_for_hook;

/// `POST /api/hooks/{session_id}` — body is Claude Code's hook payload,
/// forwarded byte-for-byte by the shim.
///
/// Always answers 204, including for events we don't model and for sessions
/// we no longer know about. The shim is fire-and-forget by design (it must
/// never stall the agent), so a distinct error status would buy nothing and
/// an unmodeled event is not a failure.
pub(super) async fn ingest_hook(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(payload): Json<Value>,
) -> StatusCode {
    let Some(event) = hook_event_name(&payload) else {
        tracing::debug!(%session_id, "hook payload has no event name; ignoring");
        return StatusCode::NO_CONTENT;
    };
    let Some(activity) = activity_for_hook(event) else {
        return StatusCode::NO_CONTENT;
    };
    let mut mgr = state.manager.lock().await;
    if !mgr.set_activity(&session_id, activity) {
        tracing::debug!(%session_id, event, "hook for unknown session; ignoring");
    }
    StatusCode::NO_CONTENT
}

/// Pull the event name out of a hook payload.
///
/// Claude Code names the field `hook_event_name`; grok's CLI names it
/// `hookEventName`. grok reads `~/.claude/settings.json` for Claude Code
/// compatibility, so our shim is already installed in its sessions and this
/// key is the only thing standing between its payloads and the projection —
/// [`activity_for_hook`] handles the value's spelling.
fn hook_event_name(payload: &Value) -> Option<&str> {
    ["hook_event_name", "hookEventName"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::Activity;
    use serde_json::json;

    #[test]
    fn reads_either_spelling_of_the_event_name_key() {
        let claude = json!({"hook_event_name": "Stop", "cwd": "/tmp"});
        assert_eq!(hook_event_name(&claude), Some("Stop"));
        let grok = json!({"hookEventName": "stop", "reason": "end_turn"});
        assert_eq!(hook_event_name(&grok), Some("stop"));
        let no_event = json!({"sessionId": "x"});
        assert_eq!(hook_event_name(&no_event), None);
        let not_a_string = json!({"hookEventName": 7});
        assert_eq!(hook_event_name(&not_a_string), None);
    }

    /// Captured verbatim from grok CLI 0.2.112. Before the key and value were
    /// normalized this payload was dropped, leaving the session's activity
    /// `Unknown` and pinned at "working" by the foreground-group fallback.
    #[test]
    fn a_real_grok_payload_reaches_the_projection() {
        let stop = r#"{"hookEventName":"stop","sessionId":"019fa69f-340d-7310-ac16-41692074143a","timestamp":"2026-07-28T02:48:03.461030205+00:00","promptId":"fbb22f75-3be8-4ad5-bda5-dd5d2cb3fcf5","permissionMode":"bypassPermissions","reason":"end_turn","stopHookActive":false,"lastAssistantMessage":"OK","backgroundTasks":[],"sessionCrons":[]}"#;
        let payload: Value = serde_json::from_str(stop).unwrap();
        let event = hook_event_name(&payload).expect("grok names the key hookEventName");
        assert_eq!(activity_for_hook(event), Some(Activity::AwaitingInput));
    }
}
