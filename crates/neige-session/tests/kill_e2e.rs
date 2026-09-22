//! End-to-end test of the terminal-mode Kill path: the exact client-side
//! sequence neige-server runs on session delete (`request_kill`), against a
//! real `neige-session-daemon`.
//!
//! The session is shaped to trip both ways a Kill used to be lost:
//! - more scrollback than a Unix socket buffers, so the daemon's `Hello`
//!   replay blocks unless the client drains it before the daemon gets to
//!   read `Kill`;
//! - a job-controlling shell (`set -m`) with a follow-up command, so the
//!   foreground job sits in its own process group and killing that group
//!   alone leaves the shell alive to run the next command.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use neige_session::request_kill;
use tokio::net::UnixStream;
use tokio::process::Command;
use uuid::Uuid;

/// Session id of `pid` from `/proc/<pid>/stat` (field after the last `)`:
/// state, ppid, pgrp, session).
fn stat_field(pid: i32, n: usize) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = &stat[stat.rfind(')')? + 1..];
    after_comm.split_whitespace().nth(n)?.parse().ok()
}

fn all_pids() -> Vec<i32> {
    std::fs::read_dir("/proc")
        .expect("read /proc")
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .collect()
}

fn children_of(ppid: i32) -> Vec<i32> {
    all_pids()
        .into_iter()
        .filter(|p| stat_field(*p, 1) == Some(ppid))
        .collect()
}

fn session_members(leader: i32) -> Vec<i32> {
    all_pids()
        .into_iter()
        .filter(|p| stat_field(*p, 3) == Some(leader))
        .collect()
}

fn comm(pid: i32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .unwrap_or_default()
        .trim()
        .to_string()
}

async fn wait_for<F: FnMut() -> bool>(mut cond: F, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cond()
}

async fn connect(sock: &Path) -> UnixStream {
    for _ in 0..150 {
        if let Ok(s) = UnixStream::connect(sock).await {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    panic!("daemon did not bind socket within 6s")
}

#[tokio::test]
async fn kill_tears_down_session_with_large_scrollback_and_job_control() {
    let daemon_bin = env!("CARGO_BIN_EXE_neige-session-daemon");
    let id = Uuid::new_v4();
    let sock = std::env::temp_dir().join(format!("neige-kill-e2e-{id}.sock"));
    let _ = std::fs::remove_file(&sock);

    // 2 MB of output overflows the daemon's 1 MiB replay buffer, so Hello
    // carries a full 1 MiB — far more than the socket can absorb unread.
    let script = "set -m; yes | head -c 2000000; echo READY; sleep 300; sleep 300";
    let mut daemon = Command::new(daemon_bin)
        .args(["--id", &id.to_string()])
        .args(["--sock", &sock.to_string_lossy()])
        .args(["--", "bash", "-c", script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn daemon");
    let daemon_pid = daemon.id().expect("daemon pid") as i32;

    // Wait until the shell is parked in its first sleep.
    let mut leader = None;
    let mut sleeper = None;
    let settled = wait_for(
        || {
            let Some(l) = children_of(daemon_pid).into_iter().next() else {
                return false;
            };
            leader = Some(l);
            sleeper = session_members(l).into_iter().find(|p| comm(*p) == "sleep");
            sleeper.is_some()
        },
        Duration::from_secs(10),
    )
    .await;
    assert!(settled, "shell never reached its foreground sleep");
    let (leader, sleeper) = (leader.unwrap(), sleeper.unwrap());
    assert_ne!(
        stat_field(sleeper, 2),
        Some(leader),
        "job control did not put the sleep in its own process group"
    );

    // The server-side kill sequence, verbatim.
    request_kill(connect(&sock).await).await;

    let gone = wait_for(
        || session_members(leader).is_empty(),
        Duration::from_secs(5),
    )
    .await;
    let survivors: Vec<String> = session_members(leader)
        .into_iter()
        .map(|p| format!("{p} {}", comm(p)))
        .collect();
    assert!(gone, "session survived Kill: {survivors:?}");

    let exited = tokio::time::timeout(Duration::from_secs(5), daemon.wait()).await;
    assert!(exited.is_ok(), "daemon did not exit after its session died");
    assert!(
        !sock.exists(),
        "daemon left stale socket at {}",
        sock.display()
    );
}
