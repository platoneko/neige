//! Per-session connection to a chat-mode `neige-session-daemon`.
//!
//! Mirrors `super::SessionClient` (terminal mode) but speaks the chat-mode
//! protocol: the wire payload is one serialized `NeigeEvent` JSON string per
//! frame instead of raw PTY bytes. Reattach replay logic is the same — each
//! event gets a monotonic seq, history caps at a few MiB, and a (re)attach
//! returns `UpToDate / Delta / Snapshot` so the WS handler can prime a
//! browser without re-running the model.
//!
//! Independent of `SessionClient` to avoid coupling the two modes' types;
//! the duplication is small and the modes evolve at different cadences.
//!
//! Wire shape on the broadcast channel: `(seq: u64, json: String)`. The
//! `String` is already serialized so the WS handler can pass it through as
//! a Text frame body without re-encoding.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};
use tracing::debug;
use uuid::Uuid;

use neige_session::{ClientMsg, DaemonMsg, read_frame, write_frame};

use super::daemon;

/// Total byte cap on the seq-tagged history. Conservative — most chat
/// sessions stay well under this.
const HISTORY_MAX_BYTES: usize = 2 * 1024 * 1024;

struct History {
    events: VecDeque<(u64, String)>,
    total_bytes: usize,
    max_bytes: usize,
    next_seq: u64,
}

impl History {
    fn new(max_bytes: usize) -> Self {
        Self {
            events: VecDeque::new(),
            total_bytes: 0,
            max_bytes,
            // Reserve seq=0 as the "snapshot / reset" marker so the WS
            // protocol can disambiguate first-attach from a delta.
            next_seq: 1,
        }
    }

    fn append(&mut self, json: String) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.total_bytes += json.len();
        self.events.push_back((seq, json));
        while self.total_bytes > self.max_bytes && self.events.len() > 1 {
            let (_, dropped) = self.events.pop_front().unwrap();
            self.total_bytes -= dropped.len();
        }
        seq
    }

    fn earliest_seq(&self) -> Option<u64> {
        self.events.front().map(|(s, _)| *s)
    }

    fn latest_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    fn since(&self, after_seq: u64) -> Vec<(u64, String)> {
        self.events
            .iter()
            .filter(|(s, _)| *s > after_seq)
            .cloned()
            .collect()
    }

    fn full_snapshot(&self) -> Vec<(u64, String)> {
        self.events.iter().cloned().collect()
    }
}

/// Result of `ChatSessionClient::attach`.
pub enum AttachResult {
    UpToDate {
        latest_seq: u64,
    },
    Delta {
        events: Vec<(u64, String)>,
        latest_seq: u64,
    },
    Snapshot {
        events: Vec<(u64, String)>,
        latest_seq: u64,
    },
}

/// Chat-mode peer of `SessionClient`.
pub struct ChatSessionClient {
    ctrl_tx: mpsc::UnboundedSender<ClientMsg>,
    pub tx: broadcast::Sender<(u64, String)>,
    history: Arc<Mutex<History>>,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

impl ChatSessionClient {
    /// Connect to the chat daemon for `id`, send the initial Attach, read
    /// the HelloChat replay, and spawn reader/writer tasks.
    pub async fn connect(id: &Uuid) -> Result<Self, String> {
        let sock_path = daemon::sock_path(id);
        let stream = UnixStream::connect(&sock_path)
            .await
            .map_err(|e| format!("connect daemon socket {sock_path:?}: {e}"))?;
        let (mut rd, mut wr) = stream.into_split();

        // cols/rows are placeholder in chat mode — daemon ignores them.
        write_frame(&mut wr, &ClientMsg::Attach { cols: 80, rows: 24 })
            .await
            .map_err(|e| format!("send Attach: {e}"))?;
        let first: DaemonMsg = read_frame(&mut rd)
            .await
            .map_err(|e| format!("read HelloChat: {e}"))?;
        let replay = match first {
            DaemonMsg::HelloChat { replay } => replay,
            other => return Err(format!("expected HelloChat, got {other:?}")),
        };

        let history = Arc::new(Mutex::new(History::new(HISTORY_MAX_BYTES)));
        let (tx, _) = broadcast::channel::<(u64, String)>(256);
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));

        // Seed history with the replay so WS clients that attach before the
        // first live event still get to see the conversation so far.
        if !replay.is_empty()
            && let Ok(mut h) = history.lock()
        {
            for json in replay {
                let seq = h.append(json.clone());
                let _ = tx.send((seq, json));
            }
        }

        // Reader: socket → (history + broadcast).
        let history_r = history.clone();
        let tx_r = tx.clone();
        let alive_r = alive.clone();
        tokio::spawn(async move {
            let mut rd = rd;
            loop {
                let msg: DaemonMsg = match read_frame(&mut rd).await {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    DaemonMsg::ChatEvent { json } => {
                        if let Ok(mut h) = history_r.lock() {
                            let seq = h.append(json.clone());
                            let _ = tx_r.send((seq, json));
                        }
                    }
                    DaemonMsg::ChildExited { code } => {
                        tracing::info!(?code, "chat daemon reported child exit");
                        break;
                    }
                    // Frames we don't expect in chat mode — ignore quietly.
                    // `Foreground` is terminal-only: a chat session has no
                    // PTY whose foreground group could be read, and its
                    // activity comes from the runner's own turn events.
                    DaemonMsg::Hello { .. }
                    | DaemonMsg::HelloChat { .. }
                    | DaemonMsg::Stdout(_)
                    | DaemonMsg::Foreground { .. } => {}
                }
            }
            alive_r.store(false, std::sync::atomic::Ordering::Relaxed);
        });

        // Writer: mpsc → socket.
        let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<ClientMsg>();
        let alive_w = alive.clone();
        tokio::spawn(async move {
            while let Some(msg) = ctrl_rx.recv().await {
                if write_frame(&mut wr, &msg).await.is_err() {
                    break;
                }
            }
            alive_w.store(false, std::sync::atomic::Ordering::Relaxed);
        });

        debug!("chat daemon attached: sock={sock_path:?}");

        Ok(Self {
            ctrl_tx,
            tx,
            history,
            alive,
        })
    }

    /// Clone of the control-channel sender; the WS handler pushes
    /// `ClientMsg::ChatUserMessage` frames through it.
    pub fn ctrl_sender(&self) -> mpsc::UnboundedSender<ClientMsg> {
        self.ctrl_tx.clone()
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Inject a server-synthesized event into the chat history + broadcast.
    ///
    /// Used by the MCP `ask_question` self-target flow to surface an
    /// "ask user a question" prompt to every WS client viewing this
    /// session, with the same delivery guarantees as a daemon-emitted
    /// event (gets a seq, lives in history, replays on reattach).
    ///
    /// `json` must be a serialized NeigeEvent variant the frontend knows
    /// how to render — typically a `Passthrough { kind, payload, ... }`.
    /// We don't validate the shape; the broadcast is a stream of strings.
    ///
    /// Returns the assigned seq, or 0 if the history mutex was poisoned
    /// (extremely unlikely; we still return a value rather than panicking
    /// because chat clients are long-lived and a poison could cascade).
    pub fn inject_synthetic_event(&self, json: String) -> u64 {
        if let Ok(mut h) = self.history.lock() {
            let seq = h.append(json.clone());
            let _ = self.tx.send((seq, json));
            seq
        } else {
            tracing::error!("chat history mutex poisoned; synthetic event dropped");
            0
        }
    }

    /// Atomically subscribe to live events and prepare the catch-up payload
    /// for a (re)attaching WS client. See `super::SessionClient::attach` for
    /// the rationale on holding the history lock across both operations.
    pub fn attach(
        &self,
        last_seq: Option<u64>,
    ) -> (broadcast::Receiver<(u64, String)>, AttachResult) {
        let history = self.history.lock().expect("history poisoned");
        let rx = self.tx.subscribe();
        let latest = history.latest_seq();
        let earliest = history.earliest_seq();

        let result = match (last_seq, earliest) {
            (Some(ls), _) if ls >= latest => AttachResult::UpToDate { latest_seq: latest },
            (Some(ls), Some(earliest_seq)) if ls >= earliest_seq.saturating_sub(1) => {
                AttachResult::Delta {
                    events: history.since(ls),
                    latest_seq: latest,
                }
            }
            _ => AttachResult::Snapshot {
                events: history.full_snapshot(),
                latest_seq: latest,
            },
        };

        (rx, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn history_starts_at_seq_one() {
        // seq=0 is reserved as the "snapshot / reset" sentinel on the wire,
        // so the first appended event must be 1.
        let mut h = History::new(1024);
        assert_eq!(h.append(ev("a")), 1);
        assert_eq!(h.append(ev("b")), 2);
        assert_eq!(h.latest_seq(), 2);
        assert_eq!(h.earliest_seq(), Some(1));
    }

    #[test]
    fn history_empty_state() {
        let h = History::new(1024);
        assert_eq!(h.latest_seq(), 0);
        assert_eq!(h.earliest_seq(), None);
        assert!(h.since(0).is_empty());
        assert!(h.full_snapshot().is_empty());
    }

    #[test]
    fn history_evicts_when_over_budget() {
        // 3 events of 100 bytes each into a 250-byte budget — oldest two
        // get dropped (eviction is chunk-granular: each append potentially
        // drops multiple front entries, but always keeps at least one).
        let mut h = History::new(250);
        h.append(ev(&"a".repeat(100)));
        h.append(ev(&"b".repeat(100)));
        h.append(ev(&"c".repeat(100)));
        assert!(h.total_bytes <= 250);
        // Latest event must always survive.
        let snap = h.full_snapshot();
        assert!(!snap.is_empty());
        assert!(snap.last().unwrap().1.starts_with('c'));
    }

    #[test]
    fn history_keeps_at_least_one_event_even_if_oversized() {
        // A single event larger than the budget must still be retained —
        // dropping it would lose the only state we have to replay.
        let mut h = History::new(50);
        let big = "x".repeat(500);
        let seq = h.append(big.clone());
        assert_eq!(h.full_snapshot(), vec![(seq, big)]);
    }

    #[test]
    fn history_since_returns_only_strictly_greater() {
        let mut h = History::new(10_000);
        h.append(ev("a")); // seq 1
        h.append(ev("b")); // seq 2
        h.append(ev("c")); // seq 3
        let after_1 = h.since(1);
        assert_eq!(after_1.len(), 2);
        assert_eq!(after_1[0].0, 2);
        assert_eq!(after_1[1].0, 3);
        // since(latest) is empty.
        assert!(h.since(3).is_empty());
        // since(0) returns everything.
        assert_eq!(h.since(0).len(), 3);
    }

    #[test]
    fn history_full_snapshot_preserves_order_and_carries_seq() {
        let mut h = History::new(10_000);
        h.append(ev("first"));
        h.append(ev("second"));
        h.append(ev("third"));
        assert_eq!(
            h.full_snapshot(),
            vec![
                (1, "first".to_string()),
                (2, "second".to_string()),
                (3, "third".to_string()),
            ],
        );
    }

    #[test]
    fn history_seq_is_monotonic_across_eviction() {
        // After eviction, next_seq must keep climbing — replay correctness
        // relies on seqs never being reused.
        let mut h = History::new(80);
        for i in 0..20 {
            h.append(ev(&format!("e{i:02}-{}", "x".repeat(10))));
        }
        assert!(h.latest_seq() >= 20);
        // earliest is much greater than 1 since older ones got evicted
        assert!(h.earliest_seq().unwrap() > 1);
    }
}
