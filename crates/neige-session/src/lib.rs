//! Wire protocol + framing helpers shared between the daemon and its clients.
//!
//! A client (neige-server, or the standalone test CLI) opens the daemon's
//! Unix socket, sends `ClientMsg::Attach {cols, rows}` as the first frame,
//! then reads a `DaemonMsg::Hello { replay }` whose `replay` is the recent
//! window of raw PTY bytes (kept in a server-side ring buffer). The client
//! feeds those bytes straight into its own VT emulator (e.g. xterm.js) to
//! repaint the screen. From there it's a duplex stream of `ClientMsg::Stdin`
//! / `ClientMsg::Resize` upstream and `DaemonMsg::Stdout` /
//! `DaemonMsg::ChildExited` downstream.
//!
//! Framing: length-prefix u32 big-endian + bincode-serde-encoded payload.

pub mod stream_json;

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use uuid::Uuid;

/// Cap on a single frame. Anything larger is either a bug or hostile.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientMsg {
    /// First message on every connection. Tells the daemon the client's
    /// viewport so the PTY can be sized for it on first attach (latest-
    /// attach-wins for subsequent clients).
    Attach { cols: u16, rows: u16 },
    /// Raw bytes from the client's keyboard → PTY stdin.
    Stdin(Vec<u8>),
    /// Viewport change after attach. Also latest-wins.
    Resize { cols: u16, rows: u16 },
    /// Ask the daemon to terminate the child (SIGHUP). The daemon's
    /// child-waiter then broadcasts ChildExited and the daemon shuts
    /// itself down.
    Kill,
    /// Chat-mode user message. The daemon serializes this onto the Node
    /// runner's stdin as `{"kind":"user_message","content":"..."}`. The
    /// runner feeds it into `@anthropic-ai/claude-agent-sdk`'s `query()`.
    /// Ignored in terminal mode.
    ChatUserMessage { content: String },
    /// Interrupt an in-flight chat turn. Daemon writes
    /// `{"kind":"stop"}` to the runner's stdin; the runner calls the SDK
    /// interrupt API. Ignored in terminal mode.
    ChatStop,
    /// Resolve an `AskUserQuestion` posed by the SDK's `canUseTool`
    /// callback. Bridges WS frontend → daemon → runner stdin so the
    /// runner-side `canUseTool` promise can resolve and the agent loop
    /// proceeds. Daemon writes
    /// `{"kind":"answer_question","question_id":"<uuid>","answers": {...}}`
    /// to the runner. Ignored in terminal mode.
    AnswerQuestion {
        question_id: Uuid,
        answers: HashMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DaemonMsg {
    /// Sent once right after `Attach` in terminal mode. `replay` is the
    /// recent PTY byte window kept in the daemon's ring buffer — feed it
    /// straight into the client's terminal emulator and it reproduces the
    /// current screen.
    Hello { replay: Vec<u8> },
    /// Sent once right after `Attach` in chat mode. `replay` is a list of
    /// already-serialized NeigeEvent JSON strings (one per buffered event)
    /// so a re-attaching client can rebuild conversation state without
    /// re-running the model.
    HelloChat { replay: Vec<String> },
    /// Live PTY output, forwarded as it arrives.
    Stdout(Vec<u8>),
    /// One serialized NeigeEvent JSON line, emitted by the daemon for each
    /// stream-json line that produced a unified event. Chat mode only.
    ChatEvent { json: String },
    /// The child program exited. Daemon will shut down right after this.
    ChildExited { code: Option<i32> },
    /// Terminal mode only: whether the child has handed the terminal to a
    /// foreground command (`true`) or is sitting at its own prompt
    /// (`false`). Sent on change, not on a schedule.
    ///
    /// Appended last on purpose — bincode encodes variants by index, so a
    /// daemon left over from an older build simply never sends this and
    /// every existing frame keeps its index.
    Foreground { running: bool },
}

fn bincode_config() -> bincode::config::Configuration {
    bincode::config::standard()
}

pub async fn write_frame<T, W>(w: &mut W, msg: &T) -> anyhow::Result<()>
where
    T: Serialize,
    W: AsyncWrite + Unpin,
{
    let buf = bincode::serde::encode_to_vec(msg, bincode_config())?;
    if buf.len() > MAX_FRAME {
        anyhow::bail!("frame too large: {} bytes", buf.len());
    }
    let len = u32::try_from(buf.len())?.to_be_bytes();
    w.write_all(&len).await?;
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_frame<T, R>(r: &mut R) -> anyhow::Result<T>
where
    T: for<'de> Deserialize<'de>,
    R: AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        anyhow::bail!("incoming frame too large: {len} bytes");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    let (msg, _) = bincode::serde::decode_from_slice(&buf, bincode_config())?;
    Ok(msg)
}

/// Upper bound on how long `request_kill` stays attached waiting for the
/// session to die. Covers the daemon's hangup grace plus its SIGKILL.
const KILL_WAIT: Duration = Duration::from_secs(5);

/// Client side of `ClientMsg::Kill` on an already-connected daemon socket:
/// Attach (required first frame), Kill, then stay attached until the daemon
/// reports `ChildExited` or closes the socket, bounded by [`KILL_WAIT`].
///
/// Why we keep reading: the daemon answers Attach with a `Hello` carrying
/// the whole replay buffer, which can be far larger than the socket buffers.
/// A client that never reads leaves that write blocked, and a client that
/// hangs up makes it fail — either way the daemon never reaches the frame
/// loop that would see the Kill. Draining frames is what lets it get there.
pub async fn request_kill(stream: UnixStream) {
    let (mut rd, mut wr) = stream.into_split();
    let _ = write_frame(&mut wr, &ClientMsg::Attach { cols: 80, rows: 24 }).await;
    let _ = write_frame(&mut wr, &ClientMsg::Kill).await;
    let drain = async {
        loop {
            match read_frame::<DaemonMsg, _>(&mut rd).await {
                Ok(DaemonMsg::ChildExited { .. }) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    };
    // Best-effort: on timeout the daemon has long since read the Kill and its
    // own SIGKILL fallback finishes the job; nothing more for us to do here.
    let _ = tokio::time::timeout(KILL_WAIT, drain).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_question_bincode_roundtrip() {
        let qid = Uuid::parse_str("6b1f3a4d-2b5e-4d7e-9c1a-1b2c3d4e5f60").unwrap();
        let original = ClientMsg::AnswerQuestion {
            question_id: qid,
            answers: HashMap::from([(
                "Which option?".to_string(),
                "the second one".to_string(),
            )]),
        };
        let encoded = bincode::serde::encode_to_vec(&original, bincode_config()).expect("encode");
        let (decoded, _): (ClientMsg, _) =
            bincode::serde::decode_from_slice(&encoded, bincode_config()).expect("decode");
        match decoded {
            ClientMsg::AnswerQuestion {
                question_id,
                answers,
            } => {
                assert_eq!(question_id, qid);
                assert_eq!(
                    answers.get("Which option?").map(String::as_str),
                    Some("the second one")
                );
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
}
