import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme, ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { writeClipboard, writeClipboardSync } from './clipboard';

/**
 * Shared WS framing contract (see crates/neige-server/src/api/ws.rs handle_ws):
 *   Client → server text JSON:
 *     {"type":"attach","last_seq":<number|null>,
 *      "attach_id":<uuid|null>}                    // first frame
 *     {"type":"resize","cols":C,"rows":R}
 *   Client → server binary: raw stdin (UTF-8 encoded keystrokes or paste).
 *   Server → client binary: [u64 BE seq][payload]. seq=0 = "reset+write".
 *   Server → client text JSON:
 *     {"type":"hello","last_seq":N,"attach_id":"<uuid>"} after initial
 *     prime, so the client knows its new baseline AND the epoch identifier
 *     to echo back on the next reconnect (so the server can detect a stale
 *     seq from a previous SessionClient instance and force a Snapshot).
 */
function readU64BE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, false);
}

export type TerminalStatus = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface UseTerminalCoreOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  theme?: ITheme;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  /** Fires on every PTY output chunk, with the sessionId + payload byte count. */
  onActivity?: (sessionId: string, byteCount: number) => void;
  /** WebSocket lifecycle status. */
  onStatusChange?: (status: TerminalStatus) => void;
  /** Called once the xterm Terminal is ready (after open()). */
  onTerminalReady?: (term: Terminal) => void;
  /** Extra xterm options merged on top of the defaults. */
  xtermOptions?: Partial<ITerminalOptions>;
}

export interface UseTerminalCoreApi {
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  wsRef: RefObject<WebSocket | null>;
  sendData: (s: string | Uint8Array) => void;
  sendResize: (cols: number, rows: number) => void;
  /**
   * Re-runs the debounced fit pipeline — call this when something external
   * (e.g. mobile visualViewport resize) changed the visible layout without
   * the container's ResizeObserver firing.
   */
  scheduleFit: () => void;
}

const MAX_RECONNECT_DELAY = 10000;

/**
 * Creates an xterm Terminal bound to a ref, connects it to `/ws/<sessionId>`
 * with the framed attach protocol, and manages reconnect + resize + activity
 * tracking. Each frontend wraps this to layer on its own concerns (theme,
 * keyboard shortcuts, viewport quirks).
 */
export function useTerminalCore(opts: UseTerminalCoreOptions): UseTerminalCoreApi {
  const {
    containerRef,
    sessionId,
    theme,
    fontFamily,
    fontSize,
    scrollback = 10000,
    onActivity,
    onStatusChange,
    onTerminalReady,
    xtermOptions,
  } = opts;

  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSeqRef = useRef<bigint | null>(null);
  const attachIdRef = useRef<string | null>(null);
  const scheduleFitRef = useRef<() => void>(() => {});

  // Keep callbacks fresh across renders without retriggering the whole
  // connect/teardown effect on every function identity change.
  const onActivityRef = useRef(onActivity);
  const onStatusChangeRef = useRef(onStatusChange);
  const onTerminalReadyRef = useRef(onTerminalReady);
  useEffect(() => {
    onActivityRef.current = onActivity;
    onStatusChangeRef.current = onStatusChange;
    onTerminalReadyRef.current = onTerminalReady;
  }, [onActivity, onStatusChange, onTerminalReady]);

  useEffect(() => {
    if (!sessionId) return;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme,
      fontFamily,
      fontSize,
      cursorBlink: true,
      scrollback,
      macOptionIsMeta: true,
      ...xtermOptions,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    container.innerHTML = '';
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    onTerminalReadyRef.current?.(term);

    // xterm.js drops OSC 52 by default, which silently breaks copy from
    // nvim/tmux/Grok inside the embedded terminal. Decode the base64 payload
    // and forward it through `writeClipboard` (Clipboard API on https, or
    // selection+execCommand on plain HTTP).
    //
    // OSC 52 arrives as PTY output over the WebSocket — by the time it hits
    // the browser the keypress that triggered the copy is long gone, so we
    // have no transient activation. Immediate write usually fails on plain
    // HTTP (and often on https without a sticky clipboard grant). Stage the
    // text and flush on the next real user gesture; without that, Grok's
    // "copy sent to ~/.grok/…" toast is the only place the text lands.
    //
    // Always stage first, then clear only on confirmed success: an async
    // Clipboard API denial that arrives after a later copy must not clobber
    // the newer pending payload, and must not drop text if we optimistically
    // cleared before knowing the write failed.
    let pendingOsc52: string | null = null;
    /**
     * Attempt to land a staged OSC 52 copy under a real user gesture.
     *
     * `selectionCopy` mutates `window.getSelection()` — doing that on a
     * keydown that was meant to start (or continue) a CJK IME composition
     * cancels the IME, which shows up as "can only type English / 中文输入法
     * 出不来" right after Grok/nvim copies something over plain HTTP (where
     * the async Clipboard API is unavailable and we rely on the selection
     * fallback). So:
     *   - keyboard events never run selectionCopy
     *   - composition keys (isComposing / keyCode 229) are a hard no-op
     *   - pointer events get the full sync path (selection + execCommand)
     * Keyboard on https still tries the Clipboard API; if that fails the
     * payload stays staged for the next click.
     */
    const flushPendingOsc52 = (e: Event) => {
      if (pendingOsc52 === null) return;

      if (e instanceof KeyboardEvent) {
        // Mid-composition or the "composition character" key — do not touch
        // selection or even fire async clipboard; leave pending for later.
        if (e.isComposing || e.keyCode === 229) return;
        const text = pendingOsc52;
        if (window.isSecureContext && navigator.clipboard?.writeText) {
          void writeClipboard(text).then((ok) => {
            if (ok && pendingOsc52 === text) pendingOsc52 = null;
          });
        }
        // No selectionCopy on keyboard: mutating Selection here breaks IME
        // activation for the very keystroke that triggered the flush.
        return;
      }

      // Pointer (or any non-keyboard gesture): full sync path.
      const text = pendingOsc52;
      // Clear first so a nested event during copy can't re-enter forever.
      pendingOsc52 = null;
      if (writeClipboardSync(text)) return;
      // Still inside a user gesture: try the async path too (https with a
      // sticky grant may succeed even when selection+execCommand refuses).
      void writeClipboard(text).then((ok) => {
        if (!ok && pendingOsc52 === null) pendingOsc52 = text;
      });
    };
    const onGestureForClipboard = (e: Event) => {
      flushPendingOsc52(e);
    };
    // Document capture: Grok's toast is in-terminal (no browser click), so
    // the next gesture on the page — including chrome outside the xterm
    // node — has to re-enter with transient activation. Pointer is the
    // reliable path for the selection-based fallback; keyboard only tries
    // the Clipboard API (see flushPendingOsc52). keyup/pointerup cover
    // browsers that grant activation on release, and catch gestures that
    // started before the OSC frame arrived over the WS.
    const gestureOpts: AddEventListenerOptions = { capture: true };
    for (const evt of ['keydown', 'keyup', 'pointerdown', 'pointerup'] as const) {
      document.addEventListener(evt, onGestureForClipboard, gestureOpts);
    }

    const osc52Disposable = term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';');
      if (semi < 0) return true;
      // Strip whitespace: some TUIs wrap long base64 payloads.
      const payload = data.slice(semi + 1).replace(/\s+/g, '');
      // "?" is a read-back query; empty clears the selection. Neither writes.
      if (!payload || payload === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        // Stage first. On insecure HTTP, selectionCopy here has no user
        // gesture (almost always fails) and — worse — mutates Selection
        // while the user may be mid-IME-composition, which cancels CJK
        // input. Only the async Clipboard API is safe to fire without a
        // gesture; the selection fallback waits for pointer flush above.
        pendingOsc52 = text;
        if (window.isSecureContext) {
          void writeClipboard(text).then((ok) => {
            // Only clear if nothing newer has replaced the pending payload.
            if (ok && pendingOsc52 === text) pendingOsc52 = null;
          });
        }
      } catch {
        /* malformed base64 */
      }
      return true;
    });

    // --- Resize pipeline ---
    // Single debounced chain: container change → fit xterm → send PTY resize.
    // 150ms debounce keeps SIGWINCH from flooding the PTY during drag resizes.
    let lastCols = 0;
    let lastRows = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const sendResize = (cols: number, rows: number) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && cols > 0 && rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        lastCols = cols;
        lastRows = rows;
      }
    };

    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        fit.fit();
        const dims = fit.proposeDimensions();
        if (dims && (dims.cols !== lastCols || dims.rows !== lastRows)) {
          sendResize(dims.cols, dims.rows);
        }
      }, 150);
    };
    scheduleFitRef.current = scheduleFit;

    // --- Activity ---
    // Output volume used to drive a busy/idle indicator here: 500 B/s for 2s
    // meant "busy", a second of silence meant "idle". That measured whether
    // the TUI was repainting, not whether the agent was doing anything — a
    // long think or a quiet build read as idle, a status line with a clock
    // read as busy, and the multi-megabyte replay frame on every reconnect
    // poisoned the running average into a busy state that stuck.
    //
    // Session activity is now reported by the server (ConvInfo.activity),
    // sourced from Claude Code lifecycle hooks and the PTY's foreground
    // process group. `onActivity` survives only as a raw output notification
    // for callers that want it; it carries no interpretation.
    const trackOutput = (byteCount: number) => {
      onActivityRef.current?.(sessionId, byteCount);
    };

    // Batch incoming PTY output per animation frame to avoid cursor jitter
    // during TUI redraws (e.g. Claude Code SIGWINCH).
    //
    // Important: `lastSeqRef` is updated on RECEIPT, not on flush. Browsers
    // throttle rAF to ~1Hz for hidden tabs, so a hidden tab accumulates
    // chunks in writeBuf for seconds while still receiving them. If WS
    // reconnects during that window and we used the last-flushed seq, the
    // server would Delta-replay everything we already have, causing visible
    // duplicate writes (and a TUI cursor-positioning mess).
    let writeBuf: { seq: bigint; bytes: Uint8Array; reset: boolean }[] = [];
    let rafId = 0;

    const flush = () => {
      rafId = 0;
      const chunks = writeBuf;
      writeBuf = [];
      let sawReset = false;
      for (const c of chunks) {
        if (c.reset) {
          // seq=0 snapshot: hard-reset then repaint. The server prefixes
          // active DEC private modes (mouse / alt-screen / …) so a TUI
          // that enabled them at startup still receives wheel events after
          // the panel was closed and remounted — see DecModeTracker.
          term.reset();
          sawReset = true;
        }
        term.write(c.bytes);
      }
      // Remount + snapshot often lands before dockview has finished sizing
      // the panel; refit so the PTY and xterm agree on cols/rows.
      if (sawReset) scheduleFit();
    };

    const wireWs = (ws: WebSocket) => {
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg && msg.type === 'hello') {
              if (typeof msg.last_seq === 'number') {
                lastSeqRef.current = BigInt(msg.last_seq);
              }
              if (typeof msg.attach_id === 'string') {
                attachIdRef.current = msg.attach_id;
              }
            }
          } catch {
            // ignore bad JSON
          }
          return;
        }
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 8) return;
        const buf = new Uint8Array(e.data);
        const seq = readU64BE(buf, 0);
        const payload = buf.subarray(8);
        if (seq === 0n) {
          // Reset invalidates any chunks we received but haven't rendered
          // yet — if we kept them, they'd be written briefly before the
          // reset clears them, causing a visible flicker of stale content.
          writeBuf = [{ seq, bytes: payload, reset: true }];
          // The snapshot frame itself carries no seq number; hello will
          // tell us the real baseline. Until that arrives, our previous
          // lastSeq is meaningless against the new history — if WS dies
          // between snapshot and hello, the next reconnect would Delta-
          // replay chunks already covered by the snapshot. Null forces
          // the safe re-snapshot path.
          lastSeqRef.current = null;
        } else {
          writeBuf.push({ seq, bytes: payload, reset: false });
          lastSeqRef.current = seq;
        }
        trackOutput(payload.byteLength);
        if (!rafId) rafId = requestAnimationFrame(flush);
      };

      ws.onerror = () => {
        // onerror is always followed by onclose; reconnect happens there.
      };

      ws.onopen = () => {
        reconnectAttempts = 0;
        onStatusChangeRef.current?.('open');
        // Attach handshake — tells the server which chunks we already have
        // (`last_seq`) and which SessionClient epoch they came from
        // (`attach_id`). If the server's current SessionClient is a different
        // instance (e.g. neige-server restarted while we held the daemon
        // alive), the epoch mismatches and the server discards last_seq to
        // force a Snapshot — without that we'd silently keep rendering on
        // top of a fresh seq=1 history.
        const ls = lastSeqRef.current;
        ws.send(
          JSON.stringify({
            type: 'attach',
            last_seq: ls === null ? null : Number(ls),
            attach_id: attachIdRef.current,
          }),
        );
        // Push dimensions so the PTY matches what we render.
        fit.fit();
        const dims = fit.proposeDimensions();
        if (dims) sendResize(dims.cols, dims.rows);
      };

      ws.onclose = (ev) => {
        if (disposed || ev.code === 1000) {
          onStatusChangeRef.current?.('closed');
          term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
          return;
        }
        onStatusChangeRef.current?.('reconnecting');
        scheduleReconnect();
      };
    };

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/${sessionId}`;
    let disposed = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      onStatusChangeRef.current?.('connecting');
      wireWs(ws);
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      reconnectAttempts++;
      const delay = Math.min(
        1000 * Math.pow(1.5, reconnectAttempts - 1),
        MAX_RECONNECT_DELAY,
      );
      reconnectTimer = setTimeout(() => {
        if (!disposed) connect();
      }, delay);
    };

    connect();

    // Forward keyboard input to the PTY as binary frames. Sending as text
    // worked by accident — the server used to fall back to "any unparseable
    // text frame is stdin", which meant a typo'd control message ended up in
    // the PTY and pasted JSON could be misread as control. Binary frames are
    // unambiguous: text = JSON control, binary = stdin.
    const stdinEncoder = new TextEncoder();
    const dataDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(stdinEncoder.encode(data));
      }
    });

    window.addEventListener('resize', scheduleFit);
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);

    // When this tab becomes visible, force a resize push even if our local
    // dimensions haven't changed — another client (e.g. phone) may have
    // shrunk the shared PTY while we were hidden, so the TUI's output is
    // now laid out for their size. Clearing lastCols/lastRows bypasses the
    // "no-op if unchanged" short-circuit in scheduleFit.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      lastCols = 0;
      lastRows = 0;
      scheduleFit();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', scheduleFit);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const evt of ['keydown', 'keyup', 'pointerdown', 'pointerup'] as const) {
        document.removeEventListener(evt, onGestureForClipboard, gestureOpts);
      }
      pendingOsc52 = null;
      ro.disconnect();
      dataDisposable.dispose();
      osc52Disposable.dispose();
      wsRef.current?.close(1000);
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
      scheduleFitRef.current = () => {};
    };
  }, [
    sessionId,
    containerRef,
    theme,
    fontFamily,
    fontSize,
    scrollback,
    xtermOptions,
  ]);

  const sendData = useCallback((s: string | Uint8Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Always send as binary — text frames are reserved for JSON control.
    // Strings (e.g. control codes like '\x01' from macOS Cmd+Arrow shortcuts)
    // get UTF-8 encoded here so callers don't each have to maintain their
    // own TextEncoder.
    if (typeof s === 'string') {
      ws.send(new TextEncoder().encode(s));
    } else {
      // WebSocket.send accepts BufferSource; cast needed because TS widens
      // to ArrayBufferLike.
      ws.send(s as unknown as ArrayBuffer);
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && cols > 0 && rows > 0) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const scheduleFit = useCallback(() => {
    scheduleFitRef.current();
  }, []);

  return { termRef, fitRef, wsRef, sendData, sendResize, scheduleFit };
}
