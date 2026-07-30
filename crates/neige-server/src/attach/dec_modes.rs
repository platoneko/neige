//! Track DEC private modes (`CSI ? … h` / `CSI ? … l`) in a PTY byte stream
//! so a reattaching xterm.js client can restore them after `term.reset()`.
//!
//! Why this exists
//! ---------------
//! Terminal-mode reattach primes the browser with a rolling ring of recent
//! PTY bytes (`AttachResult::Snapshot`), then the client does
//! `term.reset()` + `term.write(snapshot)`. Fullscreen TUIs (Grok, Claude
//! Code, vim, …) enable mouse tracking / alt-screen / bracketed paste once
//! at startup. Those CSI sequences roll out of the ring long before the
//! user closes a panel; after remount the emulator is back to defaults
//! while the app still believes mouse reporting is on. Wheel events then
//! go nowhere — xterm has no scrollback on the alt screen, and it no
//! longer synthesises mouse reports for the app.
//!
//! Tracking the *current* mode set (independent of the ring) and prefixing
//! every Snapshot with the restore CSI fixes close-and-reopen without
//! growing the history buffer.

use std::collections::BTreeSet;

/// DEC private modes that affect input routing or the visible buffer after
/// a hard reset. Everything else (origin mode, etc.) is left to the
/// snapshot content itself.
const TRACKED: &[u16] = &[
    1,    // DECCKM — application cursor keys
    7,    // DECAWM — autowrap
    25,   // DECTCEM — cursor visible
    47,   // alt screen (legacy)
    1000, // mouse: click tracking
    1002, // mouse: button-event tracking
    1003, // mouse: any-event tracking
    1004, // focus in/out
    1005, // utf-8 mouse
    1006, // SGR mouse
    1007, // alternate scroll (wheel → cursor keys on alt screen)
    1015, // urxvt mouse
    1016, // SGR-pixels mouse
    1047, // alt screen
    1048, // save/restore cursor (paired with 1049)
    1049, // alt screen + save cursor (modern)
    2004, // bracketed paste
];

fn is_tracked(mode: u16) -> bool {
    TRACKED.contains(&mode)
}

/// Incremental scanner over raw PTY output.
///
/// Maintains a small carry buffer so a CSI that straddles chunk boundaries
/// is still recognised. Only the DEC private form (`ESC [ ? …`) is parsed;
/// ECMA-48 SM/RM without `?` is ignored.
#[derive(Debug, Default, Clone)]
pub struct DecModeTracker {
    /// Currently-set tracked modes, sorted by `BTreeSet` so restore output
    /// is deterministic (nice for tests and for not reshuffling CSI).
    active: BTreeSet<u16>,
    /// Unconsumed bytes that might be the start of a CSI sequence.
    pending: Vec<u8>,
}

impl DecModeTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of PTY output. Safe to call with empty slices.
    pub fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() && self.pending.is_empty() {
            return;
        }
        // Bound the carry so a pathological non-CSI stream that happens to
        // contain ESC bytes can't grow this without bound. Real CSI mode
        // sequences are a few dozen bytes at most.
        const PENDING_CAP: usize = 64;

        let mut i = 0;
        let input = if self.pending.is_empty() {
            None
        } else {
            let mut joined = std::mem::take(&mut self.pending);
            joined.extend_from_slice(bytes);
            Some(joined)
        };
        let data: &[u8] = match &input {
            Some(v) => v.as_slice(),
            None => bytes,
        };

        while i < data.len() {
            // RIS — full reset clears every mode.
            if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'c' {
                self.active.clear();
                i += 2;
                continue;
            }

            // Soft reset `ESC [ ! p` also returns the emulator to defaults.
            if data[i] == 0x1b
                && i + 3 < data.len()
                && data[i + 1] == b'['
                && data[i + 2] == b'!'
                && data[i + 3] == b'p'
            {
                self.active.clear();
                i += 4;
                continue;
            }

            if data[i] != 0x1b {
                i += 1;
                continue;
            }
            // Incomplete ESC at end of buffer — carry it.
            if i + 1 >= data.len() {
                self.pending.push(0x1b);
                break;
            }
            if data[i + 1] != b'[' {
                i += 1;
                continue;
            }
            // Incomplete `ESC [` — carry both bytes.
            if i + 2 >= data.len() {
                self.pending.extend_from_slice(&[0x1b, b'[']);
                break;
            }
            if data[i + 2] != b'?' {
                // Not a DEC private CSI; skip the ESC and keep scanning
                // (the `[` might start something else later — rare).
                i += 1;
                continue;
            }

            // Parse `ESC [ ? <params> <final>`.
            let mut j = i + 3;
            let mut incomplete = false;
            while j < data.len() {
                let b = data[j];
                // Parameter bytes: 0x30–0x3F (digits, `;`, `?`, etc.)
                // Intermediate bytes: 0x20–0x2F
                // Final byte: 0x40–0x7E
                if (0x30..=0x3f).contains(&b) || (0x20..=0x2f).contains(&b) {
                    j += 1;
                    continue;
                }
                if (0x40..=0x7e).contains(&b) {
                    // Complete sequence spanning data[i..j+1].
                    let final_byte = b;
                    let params = &data[i + 3..j];
                    if final_byte == b'h' || final_byte == b'l' {
                        let set = final_byte == b'h';
                        apply_params(&mut self.active, params, set);
                    }
                    i = j + 1;
                    incomplete = false;
                    break;
                }
                // Invalid byte inside CSI — abandon and resync after ESC.
                i += 1;
                incomplete = false;
                break;
            }
            if j >= data.len() {
                incomplete = true;
            }
            if incomplete {
                // Sequence not finished in this chunk — carry the tail.
                let tail = &data[i..];
                if tail.len() <= PENDING_CAP {
                    self.pending.extend_from_slice(tail);
                }
                // If it exceeds the cap, drop it: a real mode CSI is short.
                break;
            }
        }
    }

    /// CSI bytes that re-enable every currently-active tracked mode.
    /// Empty when nothing is set — Snapshot then is pure history.
    ///
    /// Emits a single `ESC [ ? m1 ; m2 ; … h` so the client applies them
    /// atomically after `term.reset()`. Alt-screen modes (47/1047/1049)
    /// are listed first so subsequent mouse modes attach to the right
    /// buffer.
    pub fn restore_sequence(&self) -> Vec<u8> {
        if self.active.is_empty() {
            return Vec::new();
        }
        let mut modes: Vec<u16> = self.active.iter().copied().collect();
        modes.sort_by_key(|m| {
            // Lower sort key → earlier in the CSI parameter list.
            let primary = matches!(m, 47 | 1047 | 1049 | 1048);
            (!primary, *m)
        });
        let mut out = Vec::with_capacity(8 + modes.len() * 6);
        out.extend_from_slice(b"\x1b[?");
        for (idx, m) in modes.iter().enumerate() {
            if idx > 0 {
                out.push(b';');
            }
            out.extend_from_slice(m.to_string().as_bytes());
        }
        out.push(b'h');
        out
    }

    /// Test helper / diagnostics.
    #[cfg(test)]
    pub fn active(&self) -> &BTreeSet<u16> {
        &self.active
    }
}

fn apply_params(active: &mut BTreeSet<u16>, params: &[u8], set: bool) {
    // Params look like `1000;1002;1006` — split on `;`, ignore empties.
    let mut n: Option<u32> = None;
    let flush = |active: &mut BTreeSet<u16>, n: &mut Option<u32>, set: bool| {
        if let Some(v) = n.take() {
            if v <= u16::MAX as u32 {
                let mode = v as u16;
                if is_tracked(mode) {
                    if set {
                        active.insert(mode);
                    } else {
                        active.remove(&mode);
                    }
                }
            }
        }
    };
    for &b in params {
        if b == b';' {
            flush(active, &mut n, set);
        } else if b.is_ascii_digit() {
            let digit = (b - b'0') as u32;
            n = Some(n.unwrap_or(0).saturating_mul(10).saturating_add(digit));
        } else {
            // Unexpected parameter character (e.g. another `?`) — drop
            // the in-flight number and keep going; better to miss a mode
            // than to invent one.
            n = None;
        }
    }
    flush(active, &mut n, set);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_mouse_and_alt_screen() {
        let mut t = DecModeTracker::new();
        t.feed(b"\x1b[?1049h\x1b[?1000;1002;1006hhello");
        assert!(t.active().contains(&1049));
        assert!(t.active().contains(&1000));
        assert!(t.active().contains(&1002));
        assert!(t.active().contains(&1006));
        let restore = t.restore_sequence();
        // Alt screen first, then mouse modes ascending.
        assert_eq!(restore, b"\x1b[?1049;1000;1002;1006h");
    }

    #[test]
    fn decrst_clears_mode() {
        let mut t = DecModeTracker::new();
        t.feed(b"\x1b[?1000h\x1b[?1000l");
        assert!(t.active().is_empty());
        assert!(t.restore_sequence().is_empty());
    }

    #[test]
    fn ris_clears_all() {
        let mut t = DecModeTracker::new();
        t.feed(b"\x1b[?1049h\x1b[?1006h\x1bc");
        assert!(t.active().is_empty());
    }

    #[test]
    fn soft_reset_clears_all() {
        let mut t = DecModeTracker::new();
        t.feed(b"\x1b[?1000h\x1b[!p");
        assert!(t.active().is_empty());
    }

    #[test]
    fn straddles_chunk_boundary() {
        let mut t = DecModeTracker::new();
        t.feed(b"\x1b[?10");
        t.feed(b"00;1006h");
        assert!(t.active().contains(&1000));
        assert!(t.active().contains(&1006));
    }

    #[test]
    fn ignores_untracked_modes() {
        let mut t = DecModeTracker::new();
        // 6 = origin mode, not in TRACKED.
        t.feed(b"\x1b[?6h\x1b[?1000h");
        assert!(!t.active().contains(&6));
        assert!(t.active().contains(&1000));
    }

    #[test]
    fn plain_text_is_noop() {
        let mut t = DecModeTracker::new();
        t.feed(b"just some output\r\nwith newlines");
        assert!(t.active().is_empty());
    }
}
