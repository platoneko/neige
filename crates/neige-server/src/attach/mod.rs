//! Per-session connection to a `neige-session-daemon`.
//!
//! This module used to spawn a local PTY that ran `tmux attach-session`; now
//! the PTY lives in the daemon and we only hold a Unix-socket client to it.
//! The broadcast/history/seq logic is unchanged — it still exists here so
//! the WS handler's reconnect/replay protocol (seq=0 snapshot, delta replay)
//! keeps working on top of the same `AttachResult`.

pub mod chat;
pub mod daemon;
mod dec_modes;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};
use tracing::debug;
use uuid::Uuid;

use dec_modes::DecModeTracker;
use neige_session::{ClientMsg, DaemonMsg, read_frame, write_frame};

/// Rolling byte-chunk history, each chunk tagged with a monotonically
/// increasing sequence number. Lets a reconnecting client request "everything
/// since seq N" so it doesn't re-render content its xterm already has.
///
/// When the byte budget is exceeded we evict whole chunks from the front —
/// each chunk is a single DaemonMsg::Stdout frame, so granularity is fine.
const HISTORY_MAX_BYTES: usize = 2 * 1024 * 1024;

struct History {
    chunks: VecDeque<(u64, Vec<u8>)>,
    total_bytes: usize,
    max_bytes: usize,
    next_seq: u64,
}

impl History {
    fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_bytes: 0,
            max_bytes,
            // Start at 1 so seq=0 stays reserved as a "snapshot / reset"
            // marker on the wire. See `AttachResult::Snapshot`.
            next_seq: 1,
        }
    }

    fn append(&mut self, bytes: Vec<u8>) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.total_bytes += bytes.len();
        self.chunks.push_back((seq, bytes));
        while self.total_bytes > self.max_bytes && self.chunks.len() > 1 {
            let (_, dropped) = self.chunks.pop_front().unwrap();
            self.total_bytes -= dropped.len();
        }
        seq
    }

    fn earliest_seq(&self) -> Option<u64> {
        self.chunks.front().map(|(s, _)| *s)
    }

    fn latest_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    fn since(&self, after_seq: u64) -> Vec<(u64, Vec<u8>)> {
        self.chunks
            .iter()
            .filter(|(s, _)| *s > after_seq)
            .cloned()
            .collect()
    }

    fn full_snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total_bytes);
        for (_, bytes) in &self.chunks {
            out.extend_from_slice(bytes);
        }
        out
    }
}

/// Result of `SessionClient::attach` — tells the WS handler how to prime a new
/// connection before it starts forwarding the live broadcast.
pub enum AttachResult {
    UpToDate {
        latest_seq: u64,
    },
    Delta {
        chunks: Vec<(u64, Vec<u8>)>,
        latest_seq: u64,
    },
    Snapshot {
        bytes: Vec<u8>,
        latest_seq: u64,
    },
}

/// A session backed by a `neige-session-daemon` over a Unix socket.
pub struct SessionClient {
    /// Control channel to the daemon (Stdin / Resize / Kill frames). Writes
    /// happen on a tokio task that owns the socket's write half.
    ctrl_tx: mpsc::UnboundedSender<ClientMsg>,
    /// Live-broadcast: every DaemonMsg::Stdout byte gets a seq and fans out.
    /// Send happens under the history lock so `attach()` sees a coherent view.
    pub tx: broadcast::Sender<(u64, Vec<u8>)>,
    history: Arc<Mutex<History>>,
    /// Identifies THIS attach to the daemon. Browsers cache the value from
    /// `hello.attach_id` and echo it back on reconnect; if a new SessionClient
    /// instance (after neige-server restart / daemon resume) generates a
    /// different id, `attach()` ignores any claimed `last_seq` and forces a
    /// Snapshot rather than letting the client silently desync against a
    /// fresh seq=1 history.
    ///
    /// INVARIANT: `attach_id` is bound 1:1 to `history` for the lifetime of
    /// this `SessionClient`. Both are constructed exclusively in `connect()`
    /// and never reset. If a future change ever reuses a `SessionClient`
    /// across daemon sockets (e.g. silently reattaching), it MUST also
    /// generate a fresh `attach_id` and clear `history`, otherwise the
    /// epoch check below is meaningless.
    attach_id: Uuid,
    /// Flipped to false by the reader task when the daemon socket closes
    /// (child exit / daemon crash).
    alive: Arc<std::sync::atomic::AtomicBool>,
    /// Latest `DaemonMsg::Foreground`: whether the session's program has
    /// handed the terminal to a command. `None` until the daemon reports
    /// one — an older daemon never will, and this stays `None` forever,
    /// which reads as "no opinion" rather than "idle".
    foreground_running: Arc<Mutex<Option<bool>>>,
    /// When the reader last saw the session's PTY produce anything. `None`
    /// until the first live byte: the replay we seed history with at connect
    /// time describes the past, not whether the session is emitting now.
    /// `crate::activity::Activity::demote_if_stale` relies on that
    /// distinction.
    last_output_at: Arc<Mutex<Option<Instant>>>,
    /// Running DEC private-mode set derived from every byte that has flowed
    /// through this SessionClient (Hello seed + live Stdout). Prefixed onto
    /// Snapshot payloads so a remounted xterm.js recovers mouse / alt-screen
    /// after `term.reset()`. See `dec_modes` for the full rationale.
    ///
    /// Updated under the same critical section as `history` appends so a
    /// Snapshot always sees modes consistent with the bytes it replays.
    modes: Arc<Mutex<DecModeTracker>>,
    #[allow(dead_code)]
    sock_path: PathBuf,
}

impl SessionClient {
    /// Connect to the daemon for `id` and send the initial Attach. Spawns
    /// tasks that keep the socket plumbed: reader (socket → history +
    /// broadcast), writer (mpsc → socket), both tied to `alive`.
    pub async fn connect(id: &Uuid, cols: u16, rows: u16) -> Result<Self, String> {
        let sock_path = daemon::sock_path(id);
        let stream = UnixStream::connect(&sock_path)
            .await
            .map_err(|e| format!("connect daemon socket {sock_path:?}: {e}"))?;
        let (mut rd, mut wr) = stream.into_split();

        // Attach handshake — daemon responds with Hello{replay}.
        write_frame(&mut wr, &ClientMsg::Attach { cols, rows })
            .await
            .map_err(|e| format!("send Attach: {e}"))?;
        let first: DaemonMsg = read_frame(&mut rd)
            .await
            .map_err(|e| format!("read Hello: {e}"))?;
        let replay = match first {
            DaemonMsg::Hello { replay } => replay,
            other => return Err(format!("expected Hello, got {other:?}")),
        };

        let history = Arc::new(Mutex::new(History::new(HISTORY_MAX_BYTES)));
        let modes = Arc::new(Mutex::new(DecModeTracker::new()));
        let (tx, _) = broadcast::channel::<(u64, Vec<u8>)>(256);
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let foreground_running = Arc::new(Mutex::new(None));
        let last_output_at = Arc::new(Mutex::new(None));

        // Seed history with the replay so a WS client that attaches after us
        // can be primed from Snapshot (not wait for the first live byte).
        // Modes are fed from the same bytes so a later Snapshot can restore
        // mouse / alt-screen even after those CSI sequences leave the ring.
        if !replay.is_empty() {
            if let (Ok(mut h), Ok(mut m)) = (history.lock(), modes.lock()) {
                m.feed(&replay);
                let seq = h.append(replay.clone());
                let _ = tx.send((seq, replay));
            }
        }

        // Reader: socket → (history + broadcast). Holds history lock while
        // broadcasting so attach() sees a consistent seq.
        let history_r = history.clone();
        let modes_r = modes.clone();
        let tx_r = tx.clone();
        let alive_r = alive.clone();
        let foreground_r = foreground_running.clone();
        let last_output_r = last_output_at.clone();
        tokio::spawn(async move {
            let mut rd = rd;
            loop {
                let msg: DaemonMsg = match read_frame(&mut rd).await {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    DaemonMsg::Stdout(bytes) => {
                        if let Ok(mut t) = last_output_r.lock() {
                            *t = Some(Instant::now());
                        }
                        if let (Ok(mut h), Ok(mut m)) = (history_r.lock(), modes_r.lock()) {
                            m.feed(&bytes);
                            let seq = h.append(bytes.clone());
                            let _ = tx_r.send((seq, bytes));
                        }
                    }
                    DaemonMsg::ChildExited { code } => {
                        tracing::info!(?code, "daemon reported child exit");
                        break;
                    }
                    DaemonMsg::Foreground { running } => {
                        if let Ok(mut f) = foreground_r.lock() {
                            *f = Some(running);
                        }
                    }
                    // A second Hello would only arrive if we re-attached;
                    // we don't, so treat as noise. Chat-mode frames must
                    // never reach a terminal client — log + skip.
                    DaemonMsg::Hello { .. }
                    | DaemonMsg::HelloChat { .. }
                    | DaemonMsg::ChatEvent { .. } => {}
                }
            }
            alive_r.store(false, std::sync::atomic::Ordering::Relaxed);
        });

        // Writer: mpsc → socket. Buffering and flushing are handled frame-
        // by-frame inside write_frame.
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

        debug!("daemon attached: sock={sock_path:?}");

        Ok(Self {
            ctrl_tx,
            tx,
            history,
            modes,
            attach_id: Uuid::new_v4(),
            alive,
            foreground_running,
            last_output_at,
            sock_path,
        })
    }

    pub fn attach_id(&self) -> Uuid {
        self.attach_id
    }

    /// Clone of the control-channel sender. Callers push `ClientMsg::Stdin`
    /// frames through it to feed the daemon's PTY.
    pub fn stdin_sender(&self) -> mpsc::UnboundedSender<ClientMsg> {
        self.ctrl_tx.clone()
    }

    /// Forward a resize to the daemon (last-wins at the daemon side).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.ctrl_tx
            .send(ClientMsg::Resize { cols, rows })
            .map_err(|_| "daemon channel closed".to_string())
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Whether the session's program currently has a command in the
    /// foreground. `None` when the daemon hasn't reported — an older daemon
    /// never does.
    pub fn foreground_running(&self) -> Option<bool> {
        self.foreground_running.lock().ok().and_then(|f| *f)
    }

    /// How long since the session's PTY last produced output, or `None` if we
    /// have not seen any since attaching.
    pub fn since_last_output(&self) -> Option<Duration> {
        self.last_output_at
            .lock()
            .ok()
            .and_then(|t| *t)
            .map(|t| t.elapsed())
    }

    /// Atomically subscribe to live output and prepare the catch-up payload
    /// for a (re)attaching WS client. Holding the history lock across both
    /// the snapshot and the subscribe blocks the socket reader — any chunk
    /// it appends after we release will carry a strictly-greater seq and
    /// be delivered to the returned receiver without loss.
    ///
    /// `claimed_attach_id` is what the client echoed back from a previous
    /// `hello.attach_id`. If it doesn't match this SessionClient's id, the
    /// client's `last_seq` belongs to a different epoch (this instance was
    /// recreated after a server restart, etc.) and is meaningless against
    /// the current history — fall through to Snapshot.
    pub fn attach(
        &self,
        last_seq: Option<u64>,
        claimed_attach_id: Option<Uuid>,
    ) -> (broadcast::Receiver<(u64, Vec<u8>)>, AttachResult) {
        // Lock history then modes (same order as the reader task) so we
        // can't deadlock against a concurrent Stdout append.
        let history = self.history.lock().expect("history poisoned");
        let modes = self.modes.lock().expect("modes poisoned");
        let rx = self.tx.subscribe();
        let latest = history.latest_seq();
        let earliest = history.earliest_seq();

        let effective_last_seq = match claimed_attach_id {
            Some(claim) if claim == self.attach_id => last_seq,
            // Either a fresh client (no claim) or a stale-epoch client.
            // Either way, can't trust last_seq against our current history.
            _ => None,
        };

        let result = match (effective_last_seq, earliest) {
            (Some(ls), _) if ls >= latest => AttachResult::UpToDate { latest_seq: latest },
            (Some(ls), Some(earliest_seq)) if ls >= earliest_seq.saturating_sub(1) => {
                AttachResult::Delta {
                    chunks: history.since(ls),
                    latest_seq: latest,
                }
            }
            _ => {
                // Client will `term.reset()` before writing these bytes.
                // Prefix the active DEC private modes so mouse tracking /
                // alt-screen survive a panel close+reopen even after the
                // original enable CSI has left the history ring.
                let restore = modes.restore_sequence();
                let body = history.full_snapshot();
                let mut bytes = Vec::with_capacity(restore.len() + body.len());
                bytes.extend_from_slice(&restore);
                bytes.extend_from_slice(&body);
                AttachResult::Snapshot {
                    bytes,
                    latest_seq: latest,
                }
            }
        };

        (rx, result)
    }
}

// No explicit Drop — we deliberately do NOT kill the daemon when the
// SessionClient is dropped. Daemons must survive neige-server restarts; the
// explicit lifecycle is `daemon::kill_session` called from the conversation
// manager's `remove()`.
