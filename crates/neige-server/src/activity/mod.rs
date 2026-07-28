//! Agent activity — is the agent inside a session working, waiting on the
//! human, or done for now?
//!
//! Deliberately separate from [`crate::conversation::Status`], which reports
//! whether the session's daemon process is alive. A session is routinely
//! `Running` and `Idle` at the same time; the sidebar wants both answers.
//!
//! The signal comes from Claude Code lifecycle hooks, not from watching PTY
//! output. That matters more than where the code runs: the byte-rate
//! heuristic this replaces measured whether the TUI was repainting, and
//! inferred "idle" from a second of terminal silence — so every pause longer
//! than the window (a long think, a slow tool, a permission prompt) read as
//! the agent being done, while any periodic repaint (a status line, a clock)
//! read as it being busy.
//!
//! Every transition is therefore caused by a lifecycle event, with one
//! exception the events themselves force: an interrupted turn fires no
//! `Stop`, so a `Working` that has had neither a hook nor a byte of terminal
//! output behind it for a minute is demoted when the state is read. See
//! [`Activity::demote_if_stale`] — the only place a clock enters, and it can
//! only ever lower a reading, never raise one.

pub mod install;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// What the agent in a session is doing. Ordering is not meaningful — the
/// projection is last-event-wins, see [`activity_for_hook`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    /// No lifecycle signal has arrived for this session. Either it runs a
    /// plain shell with no agent in it, or the hooks aren't installed. The
    /// UI renders this as "no opinion", not as idle.
    #[default]
    Unknown,
    /// An agent is present but not mid-turn.
    Idle,
    /// Mid-turn: prompt submitted, tools running, or reasoning between them.
    Working,
    /// Blocked on the human — a permission prompt, an MCP elicitation, or a
    /// finished turn waiting for the next instruction. This is the state the
    /// old heuristic could not see at all: Claude sitting at a permission
    /// prompt emits nothing, so silence read as idle.
    AwaitingInput,
}

/// One Claude Code hook this server subscribes to.
///
/// The same table generates the settings file and drives the projection, so a
/// hook can never be projected without also being registered — the two lists
/// cannot drift apart.
pub struct HookBinding {
    /// PascalCase event name. Used verbatim as the key in the generated
    /// `hooks` map — Claude Code looks that key up literally — and matched
    /// leniently against the payload's event name, see [`activity_for_hook`].
    pub event: &'static str,
    /// Whether the settings entry carries `"matcher": "*"`. Only the
    /// tool-scoped hooks take one; for the rest, omitting it means match-all,
    /// which is what we want.
    pub matcher: bool,
    pub activity: Activity,
}

pub const HOOK_BINDINGS: &[HookBinding] = &[
    HookBinding {
        event: "SessionStart",
        matcher: false,
        activity: Activity::Idle,
    },
    HookBinding {
        event: "UserPromptSubmit",
        matcher: false,
        activity: Activity::Working,
    },
    HookBinding {
        event: "PreToolUse",
        matcher: true,
        activity: Activity::Working,
    },
    // `PostToolUse` stays `Working`, not `Idle`: the agent is still mid-turn
    // between tool calls, reasoning about the next step. Mapping it to idle
    // and papering over the gap with a quiet-period timer is exactly the
    // failure this module exists to remove.
    HookBinding {
        event: "PostToolUse",
        matcher: true,
        activity: Activity::Working,
    },
    HookBinding {
        event: "PermissionRequest",
        matcher: true,
        activity: Activity::AwaitingInput,
    },
    HookBinding {
        event: "Elicitation",
        matcher: false,
        activity: Activity::AwaitingInput,
    },
    HookBinding {
        event: "Notification",
        matcher: false,
        activity: Activity::AwaitingInput,
    },
    // A finished turn means the human is the bottleneck, so `Stop` is
    // `AwaitingInput` rather than `Idle` — the sidebar should surface it.
    // `Idle` is reserved for "an agent is loaded but hasn't been given
    // anything yet".
    HookBinding {
        event: "Stop",
        matcher: false,
        activity: Activity::AwaitingInput,
    },
    // A turn that died on an API error also needs the human, and needs
    // nothing else from the UI that `AwaitingInput` doesn't already say.
    HookBinding {
        event: "StopFailure",
        matcher: false,
        activity: Activity::AwaitingInput,
    },
    // Back to `Unknown`, not `Idle`. The agent is gone, so we no longer have
    // an agent-level opinion — and a terminal session outlives the claude
    // that ran inside it. Reporting `Idle` would pin the session there while
    // the user's next `cargo build` runs; `Unknown` hands the question back
    // to the shell-level signal (see `Activity::resolve`).
    HookBinding {
        event: "SessionEnd",
        matcher: false,
        activity: Activity::Unknown,
    },
];

impl Activity {
    /// Combine the agent-level reading with the shell-level one.
    ///
    /// Hooks win whenever they have something to say. While a claude is
    /// running, the terminal's foreground group is *always* "a command is
    /// running" — true but useless, since it stays that way whether the agent
    /// is mid-turn or parked at its prompt. The hooks know the difference.
    ///
    /// `foreground_running` only gets a say for a session with no agent in
    /// it: a plain shell, or one whose claude has exited.
    pub fn resolve(self, foreground_running: Option<bool>) -> Activity {
        match (self, foreground_running) {
            (Activity::Unknown, Some(true)) => Activity::Working,
            (Activity::Unknown, Some(false)) => Activity::Idle,
            (known, _) => known,
        }
    }

    /// How long a `Working` session must go without any lifecycle event *and*
    /// without any terminal output before we stop believing it.
    ///
    /// Sized against what a mid-turn agent emits rather than against how long
    /// a turn runs: both TUIs repaint an elapsed-time counter about once a
    /// second, so a full minute of silence is far outside anything a live turn
    /// produces.
    pub const STALE_WORKING: Duration = Duration::from_secs(60);

    /// Give up on a `Working` that nothing is backing any more.
    ///
    /// A turn can end without a `Stop`: Claude Code and grok both skip the
    /// stop hooks when the user interrupts (Esc / Ctrl+C), when a turn is
    /// refused, and when it hits its max-turns cap. Last-event-wins then pins
    /// the session at `Working` until whenever its next prompt happens to
    /// arrive, which is what this undoes.
    ///
    /// Silence on its own is not evidence — inferring idle from it is the
    /// byte-rate mistake this module exists to remove. It counts here only
    /// alongside hook silence, and only in one direction: nothing in this
    /// function may raise a session to `Working`.
    ///
    /// `output_age` is `None` when we have never seen this session's terminal
    /// produce anything. Never having observed output is a different claim
    /// from having watched it stop, so that case holds `Working`.
    pub fn demote_if_stale(self, event_age: Duration, output_age: Option<Duration>) -> Activity {
        let (Activity::Working, Some(output_age)) = (self, output_age) else {
            return self;
        };
        if event_age >= Self::STALE_WORKING && output_age >= Self::STALE_WORKING {
            Activity::AwaitingInput
        } else {
            self
        }
    }
}

/// Project a payload's event name onto an activity.
///
/// Matching ignores case and `_` because grok's CLI reads the same
/// `~/.claude/settings.json` and so runs the same shim, but spells the events
/// `session_start` where Claude Code spells them `SessionStart`. Normalizing
/// here rather than in [`HOOK_BINDINGS`] keeps one table serving both wire
/// dialects while the generated settings file stays PascalCase.
///
/// `None` means we don't model that event; the caller leaves the session's
/// current activity alone rather than guessing. grok emits several events
/// Claude Code has no equivalent for, and they land here.
pub fn activity_for_hook(event: &str) -> Option<Activity> {
    HOOK_BINDINGS
        .iter()
        .find(|b| same_event(b.event, event))
        .map(|b| b.activity)
}

/// Compare event names across the `SessionStart` / `session_start` spellings.
/// Whole-string, so near misses like grok's `post_tool_use_failure` still miss
/// the `PostToolUse` binding.
fn same_event(a: &str, b: &str) -> bool {
    fn letters(s: &str) -> impl Iterator<Item = u8> + '_ {
        s.bytes()
            .filter(|c| *c != b'_')
            .map(|c| c.to_ascii_lowercase())
    }
    letters(a).eq(letters(b))
}

/// Render the `hooks` block of a Claude Code settings file, pointing every
/// bound event at `command`.
///
/// `command` receives the hook payload on stdin and reads the event name from
/// its `hook_event_name` field, so the generated command string is identical
/// for every event and carries no event name of its own to fall out of sync.
pub fn settings_hooks_json(command: &str) -> Value {
    let hook = json!({ "type": "command", "command": command });
    let entries = HOOK_BINDINGS.iter().map(|b| {
        let group = if b.matcher {
            json!({ "matcher": "*", "hooks": [hook.clone()] })
        } else {
            json!({ "hooks": [hook.clone()] })
        };
        (b.event.to_string(), json!([group]))
    });
    json!({ "hooks": Value::Object(entries.collect()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bound_hook_is_registered_in_settings() {
        let v = settings_hooks_json("/usr/bin/neige-hook");
        let hooks = v["hooks"].as_object().expect("hooks is an object");
        assert_eq!(hooks.len(), HOOK_BINDINGS.len());
        for b in HOOK_BINDINGS {
            let group = &hooks[b.event][0];
            assert_eq!(group["hooks"][0]["command"], "/usr/bin/neige-hook");
            assert_eq!(group.get("matcher").is_some(), b.matcher, "{}", b.event);
        }
    }

    #[test]
    fn projects_the_turn_boundaries_that_drive_the_sidebar() {
        assert_eq!(activity_for_hook("UserPromptSubmit"), Some(Activity::Working));
        assert_eq!(activity_for_hook("PostToolUse"), Some(Activity::Working));
        assert_eq!(activity_for_hook("Stop"), Some(Activity::AwaitingInput));
        assert_eq!(
            activity_for_hook("PermissionRequest"),
            Some(Activity::AwaitingInput)
        );
        assert_eq!(activity_for_hook("SessionStart"), Some(Activity::Idle));
    }

    #[test]
    fn a_shell_with_no_agent_falls_back_to_its_foreground_group() {
        assert_eq!(Activity::Unknown.resolve(Some(true)), Activity::Working);
        assert_eq!(Activity::Unknown.resolve(Some(false)), Activity::Idle);
        assert_eq!(Activity::Unknown.resolve(None), Activity::Unknown);
    }

    #[test]
    fn hooks_outrank_the_foreground_group_while_an_agent_is_loaded() {
        // The terminal's foreground group says "a command is running" for the
        // entire life of a claude process, including while it sits at its own
        // prompt waiting for the user. The hook reading is the true one.
        assert_eq!(
            Activity::AwaitingInput.resolve(Some(true)),
            Activity::AwaitingInput
        );
        assert_eq!(Activity::Idle.resolve(Some(true)), Activity::Idle);
        assert_eq!(Activity::Working.resolve(Some(false)), Activity::Working);
    }

    #[test]
    fn session_end_hands_the_session_back_to_the_shell_signal() {
        // Otherwise a session whose claude exited would stay pinned at the
        // agent's last state while the user runs unrelated commands in it.
        assert_eq!(activity_for_hook("SessionEnd"), Some(Activity::Unknown));
        assert_eq!(
            activity_for_hook("SessionEnd").unwrap().resolve(Some(true)),
            Activity::Working
        );
    }

    /// Comfortably past `STALE_WORKING`, so the tests read as "long ago"
    /// rather than as arithmetic against the constant.
    const LONG_AGO: Duration = Duration::from_secs(600);
    const JUST_NOW: Duration = Duration::from_secs(1);

    #[test]
    fn an_interrupted_turn_stops_being_reported_as_working() {
        // Esc mid-turn fires no `Stop`, so nothing else will ever move this
        // session off `Working`.
        assert_eq!(
            Activity::Working.demote_if_stale(LONG_AGO, Some(LONG_AGO)),
            Activity::AwaitingInput
        );
    }

    #[test]
    fn a_turn_still_repainting_its_spinner_is_left_alone() {
        // The long-tool-call case: no hook between PreToolUse and PostToolUse,
        // but the TUI is still drawing, so the turn is alive.
        assert_eq!(
            Activity::Working.demote_if_stale(LONG_AGO, Some(JUST_NOW)),
            Activity::Working
        );
        // And the mirror image — hooks arriving keeps it alive through a
        // quiet stretch of terminal.
        assert_eq!(
            Activity::Working.demote_if_stale(JUST_NOW, Some(LONG_AGO)),
            Activity::Working
        );
    }

    #[test]
    fn never_having_seen_output_is_not_the_same_as_output_stopping() {
        assert_eq!(
            Activity::Working.demote_if_stale(LONG_AGO, None),
            Activity::Working
        );
    }

    #[test]
    fn staleness_can_only_lower_a_reading() {
        // Otherwise silence would once again mean "idle", which is the
        // heuristic this module replaced.
        for state in [Activity::Unknown, Activity::Idle, Activity::AwaitingInput] {
            assert_eq!(state.demote_if_stale(LONG_AGO, Some(LONG_AGO)), state);
        }
    }

    #[test]
    fn a_demoted_turn_outranks_the_foreground_group() {
        // The claude process is still in the terminal's foreground group after
        // an interrupt, so the fallback would say `Working` all over again.
        let demoted = Activity::Working.demote_if_stale(LONG_AGO, Some(LONG_AGO));
        assert_eq!(demoted.resolve(Some(true)), Activity::AwaitingInput);
    }

    #[test]
    fn unmodeled_hooks_leave_activity_untouched() {
        assert_eq!(activity_for_hook("PreCompact"), None);
        assert_eq!(activity_for_hook(""), None);
    }

    #[test]
    fn groks_snake_case_events_project_like_claudes_pascal_case_ones() {
        assert_eq!(activity_for_hook("session_start"), Some(Activity::Idle));
        assert_eq!(
            activity_for_hook("user_prompt_submit"),
            Some(Activity::Working)
        );
        assert_eq!(activity_for_hook("pre_tool_use"), Some(Activity::Working));
        assert_eq!(activity_for_hook("post_tool_use"), Some(Activity::Working));
        assert_eq!(activity_for_hook("stop"), Some(Activity::AwaitingInput));
        assert_eq!(activity_for_hook("session_end"), Some(Activity::Unknown));
        // Casing on its own must not matter either, so a third dialect that
        // sends `sessionStart` needs no further change here.
        assert_eq!(activity_for_hook("sessionStart"), Some(Activity::Idle));
        for b in HOOK_BINDINGS {
            assert_eq!(
                activity_for_hook(&b.event.to_ascii_lowercase()),
                Some(b.activity),
                "{}",
                b.event
            );
        }
    }

    #[test]
    fn groks_extra_lifecycle_events_stay_unmodeled() {
        // grok emits events Claude Code has no equivalent for. The near
        // misses are the point: lenient matching must not let
        // `post_tool_use_failure` reach the `PostToolUse` binding, nor
        // `subagent_stop` reach `Stop`.
        for event in [
            "post_tool_use_failure",
            "permission_denied",
            "subagent_start",
            "subagent_stop",
            "post_compact",
        ] {
            assert_eq!(activity_for_hook(event), None, "{event}");
        }
    }

    #[test]
    fn lenient_matching_does_not_leak_into_the_generated_settings() {
        // Claude Code looks its hook keys up verbatim, so the file we install
        // must keep the PascalCase spelling even though the projection now
        // also accepts grok's.
        let v = settings_hooks_json("/usr/bin/neige-hook");
        let hooks = v["hooks"].as_object().unwrap();
        assert!(hooks.contains_key("SessionStart"));
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(!hooks.keys().any(|k| k.contains('_')), "{hooks:?}");
    }

    #[test]
    fn activity_serializes_to_the_wire_names_the_web_client_reads() {
        let json = serde_json::to_string(&Activity::AwaitingInput).unwrap();
        assert_eq!(json, "\"awaiting_input\"");
        assert_eq!(serde_json::to_string(&Activity::Unknown).unwrap(), "\"unknown\"");
    }
}
