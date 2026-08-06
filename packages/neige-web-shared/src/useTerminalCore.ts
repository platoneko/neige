import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme, ITerminalOptions, ITerminalAddon } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// Canvas renderer: xterm 6 defaults to DOM, which drifts CJK/box-drawing
// right edges (letter-spacing on text runs). See tryEnableCanvasRenderer.
import { CanvasAddon } from '@xterm/addon-canvas';
import { writeClipboardApiOnly, writeClipboardSync } from './clipboard';

/**
 * Enable the canvas renderer. xterm.js 6 ships DomRenderer by default;
 * mixed CJK + box-drawing then drifts the right edge of rows (measured
 * outer `│`/`┆` at different x, some past the screen edge) so Grok
 * fullscreen borders look misaligned. Canvas paints on a fixed cell grid.
 * Returns the addon so the caller can dispose it, or null if canvas fails
 * (headless / no 2d context) — terminal keeps DOM renderer.
 */
function tryEnableCanvasRenderer(term: Terminal): ITerminalAddon | null {
  try {
    const addon = new CanvasAddon();
    term.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}

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

/**
 * Measure cols/rows from the fit parent using live cell metrics and the
 * *actual* scrollbar gutter.
 *
 * `@xterm/addon-fit` always subtracts 14px whenever `scrollback > 0`
 * (`overviewRuler?.width || 14`). That under-counts by 1–2 cols when:
 *   - the scrollbar is overlay / width 0, or
 *   - the app is on the alt screen (Grok / Claude / vim) and no bar shows.
 * Fullscreen box-drawing borders then sit short of the panel edge —
 * "jagged / misaligned frame" after refresh.
 *
 * We keep FitAddon for `fit()` / resize plumbing but replace its
 * `proposeDimensions` with this.
 */
function proposeExactDimensions(
  term: Terminal,
  container: HTMLElement,
): { cols: number; rows: number } | undefined {
  // Cell metrics live on the private render service — same path FitAddon uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cell = (term as any)._core?._renderService?.dimensions?.css?.cell as
    | { width: number; height: number }
    | undefined;
  if (!cell || cell.width === 0 || cell.height === 0) return undefined;

  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width <= 0 || height <= 0) return undefined;

  let padX = 0;
  let padY = 0;
  if (term.element) {
    const cs = window.getComputedStyle(term.element);
    padX =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    padY =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }

  // Live gutter only. 0 when overlay, hidden, or content does not overflow.
  let scrollbarW = 0;
  const viewport = term.element?.querySelector(
    '.xterm-viewport',
  ) as HTMLElement | null;
  if (viewport) {
    scrollbarW = Math.max(0, viewport.offsetWidth - viewport.clientWidth);
  }

  const cols = Math.max(2, Math.floor((width - padX - scrollbarW) / cell.width));
  const rows = Math.max(1, Math.floor((height - padY) / cell.height));
  return { cols, rows };
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
    // Must load after open() — canvas addon binds to the screen element.
    const canvasAddon = tryEnableCanvasRenderer(term);
    // Replace FitAddon's proposeDimensions (always −14px scrollbar) with a
    // measurement that uses the live gutter. fit.fit() calls this.
    fit.proposeDimensions = () => proposeExactDimensions(term, container);
    termRef.current = term;
    fitRef.current = fit;
    onTerminalReadyRef.current?.(term);

    // xterm.js drops OSC 52 by default, which silently breaks copy from
    // nvim/tmux/Grok inside the embedded terminal. Decode the base64 payload
    // and forward it through the clipboard helpers.
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
    // the newer pending payload.
    //
    // HTTP has no Clipboard API. Land OSC 52 on the next user gesture via
    // eventCopy (copy-event + execCommand — no Selection, no blur). That
    // keeps CJK IME alive and still works over plain HTTP. Keyboard uses
    // the same path only when not mid-composition.
    let pendingOsc52: string | null = null;
    let imeComposing = false;
    const onCompositionStart = () => {
      imeComposing = true;
    };
    const onCompositionEnd = () => {
      imeComposing = false;
    };
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);

    /**
     * Attempt to land a staged OSC 52 copy under a real user gesture.
     *
     *   - mid-composition: leave pending (don't interrupt candidates)
     *   - otherwise: writeClipboardSync → eventCopy first, then selection
     *     with yieldImeHost as last resort
     * Failed writes re-stage the payload for a later gesture.
     */
    const flushPendingOsc52 = (e: Event) => {
      if (pendingOsc52 === null) return;
      const text = pendingOsc52;

      if (e instanceof KeyboardEvent) {
        if (e.isComposing || e.keyCode === 229 || imeComposing) return;
      } else if (imeComposing) {
        return;
      }

      // Clear first so a nested event during copy can't re-enter forever.
      pendingOsc52 = null;
      if (writeClipboardSync(text, { yieldImeHost: true })) return;
      // Sync path failed — re-stage for the next gesture. On https still
      // try the async API (sticky grant); clear only if this payload wins.
      pendingOsc52 = text;
      void writeClipboardApiOnly(text).then((ok) => {
        if (ok && pendingOsc52 === text) pendingOsc52 = null;
      });
    };
    const onGestureForClipboard = (e: Event) => {
      flushPendingOsc52(e);
    };
    // Document capture: Grok's toast is in-terminal (no browser click), so
    // the next gesture on the page — including chrome outside the xterm
    // node — has to re-enter with transient activation. keyup/pointerup
    // cover browsers that grant activation on release.
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
        // Stage first. Never selectionCopy here — no user gesture.
        // Clipboard API only on arrival; selection waits for pointer flush.
        pendingOsc52 = text;
        void writeClipboardApiOnly(text).then((ok) => {
          if (ok && pendingOsc52 === text) pendingOsc52 = null;
        });
      } catch {
        /* malformed base64 */
      }
      return true;
    });

    // --- Resize pipeline ---
    // Debounced container → fit xterm → send PTY resize. 150ms keeps
    // SIGWINCH from flooding the PTY during drag resizes. Snapshot/open
    // use a faster path + double rAF so dockview layout settling and
    // async webfont metrics don't leave fullscreen TUIs (Grok) one cell
    // short at the edges.
    //
    // After a seq=0 Snapshot we additionally:
    //   1. Clear the alt-screen if the restore prefix re-entered one —
    //      ring replay is often a mid-frame and paints garbage until the
    //      TUI full-repaints.
    //   2. Force a PTY winsize *change* (nudge then restore). Linux only
    //      delivers SIGWINCH when TIOCSWINSZ actually changes size — a
    //      same-size resize after browser refresh is a no-op, so Grok
    //      never full-repaints.
    let disposed = false;
    let lastCols = 0;
    let lastRows = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let fitRaf1 = 0;
    let fitRaf2 = 0;
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    // Sticky until forcePtyRedraw actually runs (container may still be
    // 0×0 when the first post-snapshot fit fires). RO/open retries keep
    // seeing this and upgrade to immediate.
    let pendingForceRedraw = false;

    const sendResize = (cols: number, rows: number, opts?: { record?: boolean }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && cols > 0 && rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        if (opts?.record !== false) {
          lastCols = cols;
          lastRows = rows;
        }
      }
    };

    /** Push a real winsize change so the child gets SIGWINCH even when the
     *  settled size already matches the PTY (common after browser refresh). */
    const forcePtyRedraw = (cols: number, rows: number): boolean => {
      if (disposed || cols < 2 || rows < 2) return false;
      if (nudgeTimer) clearTimeout(nudgeTimer);
      // Nudge rows by ±1 first (don't record — intermediate size is not
      // the settled client size). Restore after a short delay so the kernel
      // delivers two distinct TIOCSWINSZ / SIGWINCH events; a 0ms timeout
      // can collapse them before the TUI wakes.
      const nudgedRows = rows > 2 ? rows - 1 : rows + 1;
      sendResize(cols, nudgedRows, { record: false });
      nudgeTimer = setTimeout(() => {
        nudgeTimer = undefined;
        if (disposed) return;
        sendResize(cols, rows);
        try {
          // Drop any stale glyph atlas from the pre-resize ring paint.
          term.clearTextureAtlas?.();
          term.refresh(0, term.rows - 1);
        } catch {
          /* disposed mid-refresh */
        }
      }, 50);
      return true;
    };

    const runFit = (opts?: { forceRedraw?: boolean }): boolean => {
      if (disposed) return false;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      fit.fit();
      const dims = fit.proposeDimensions();
      if (!dims) return true;
      if (opts?.forceRedraw) {
        // Always end on a SIGWINCH-producing resize after Snapshot, even
        // when cols/rows already match lastCols/lastRows / the daemon.
        if (forcePtyRedraw(dims.cols, dims.rows)) {
          pendingForceRedraw = false;
        }
        return true;
      }
      if (dims.cols !== lastCols || dims.rows !== lastRows) {
        sendResize(dims.cols, dims.rows);
      }
      return true;
    };

    /** After a layout-critical event, fit now and once more after paint. */
    const fitWithSettle = (opts?: { forceRedraw?: boolean }) => {
      // First pass sizes the local emulator. Final pass after paint can
      // force a PTY redraw (Snapshot reattach) once layout has settled.
      runFit();
      if (fitRaf1) cancelAnimationFrame(fitRaf1);
      if (fitRaf2) cancelAnimationFrame(fitRaf2);
      fitRaf1 = requestAnimationFrame(() => {
        fitRaf1 = 0;
        fitRaf2 = requestAnimationFrame(() => {
          fitRaf2 = 0;
          runFit(opts);
        });
      });
    };

    const scheduleFit = (opts?: { immediate?: boolean; forceRedraw?: boolean }) => {
      if (opts?.forceRedraw) pendingForceRedraw = true;
      // Upgrade to immediate while a force-redraw is outstanding so a
      // debounced RO tick cannot postpone / drop the Snapshot nudge.
      const immediate = !!opts?.immediate || pendingForceRedraw;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        // Do NOT clear pendingForceRedraw here — only forcePtyRedraw does,
        // once the container has a real size.
        if (immediate) {
          fitWithSettle({ forceRedraw: pendingForceRedraw });
        } else {
          runFit();
        }
      }, immediate ? 0 : 150);
    };
    scheduleFitRef.current = () => scheduleFit();

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

    /** Snapshot restore prefix re-enters alt-screen when these DEC modes are set. */
    const payloadEnablesAltScreen = (bytes: Uint8Array): boolean => {
      const n = Math.min(bytes.byteLength, 256);
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]!);
      // restore_sequence is `ESC [ ? m1 ; m2 ; … h` with alt modes first.
      return (
        /\x1b\[\?[\d;]*1049[\d;]*h/.test(s) ||
        /\x1b\[\?[\d;]*1047[\d;]*h/.test(s) ||
        /\x1b\[\?(?:[\d;]*;)?47(?:;[\d;]*)?h/.test(s)
      );
    };

    const flush = () => {
      rafId = 0;
      const chunks = writeBuf;
      writeBuf = [];
      let sawReset = false;
      let altScreenSnapshot = false;
      let pending = 0;
      let finished = 0;

      const onWritesDone = () => {
        if (disposed) return;
        if (!sawReset) return;
        // Remount + snapshot often lands before dockview has finished sizing
        // the panel; wait until write() has parsed the ring so fit/resize
        // does not reflow mid-parse. For fullscreen TUIs, wipe the (often
        // mid-frame) ring paint first — SIGWINCH then makes the app repaint
        // a clean screen. Shells without alt-screen keep the replay.
        const afterClear = () => {
          if (!disposed) scheduleFit({ immediate: true, forceRedraw: true });
        };
        if (altScreenSnapshot) {
          term.write('\x1b[H\x1b[2J', afterClear);
        } else {
          afterClear();
        }
      };

      for (const c of chunks) {
        if (c.reset) {
          // seq=0 snapshot: hard-reset then repaint. The server prefixes
          // active DEC private modes (mouse / alt-screen / …) so a TUI
          // that enabled them at startup still receives wheel events after
          // the panel was closed and remounted — see DecModeTracker.
          term.reset();
          sawReset = true;
          if (payloadEnablesAltScreen(c.bytes)) altScreenSnapshot = true;
        }
        pending++;
        term.write(c.bytes, () => {
          finished++;
          if (finished >= pending) onWritesDone();
        });
      }
      // Empty batch (shouldn't happen) — still honour reset if set.
      if (pending === 0) onWritesDone();
    };

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/${sessionId}`;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
        // Don't fit with a zero-size container (dockview mid-layout). The
        // settle path retries after paint; RO also fires when size arrives.
        scheduleFit({ immediate: true });
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

    const onWindowResize = () => scheduleFit();
    window.addEventListener('resize', onWindowResize);
    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(container);

    // When this tab becomes visible, force a resize push even if our local
    // dimensions haven't changed — another client (e.g. phone) may have
    // shrunk the shared PTY while we were hidden, so the TUI's output is
    // now laid out for their size. Clearing lastCols/lastRows bypasses the
    // "no-op if unchanged" short-circuit in runFit.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      lastCols = 0;
      lastRows = 0;
      scheduleFit({ immediate: true });
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Webfonts (JetBrains Mono) load async. First open often measures the
    // fallback face (narrower cells → over-count cols, e.g. 90 instead of
    // 79) and ships that winsize to the PTY. When the real face arrives
    // glyphs are wider than the cell grid → Grok box-drawing borders look
    // misaligned. Force CharSizeService to remeasure (it only runs on
    // fontFamily/fontSize option change) then fit + SIGWINCH.
    const remeasureFontsAndFit = () => {
      if (disposed) return;
      try {
        // CharSizeService only remeasures on option *change*. Re-assigning
        // the same fontFamily is a no-op, so bump fontSize by an epsilon
        // and restore — that fires measure() with the now-loaded face.
        const size = term.options.fontSize ?? 14;
        term.options.fontSize = size + 0.01;
        term.options.fontSize = size;
        // Also hit the private service directly (same path open() uses).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const core = (term as any)._core as
          | { _charSizeService?: { measure?: () => void } }
          | undefined;
        core?._charSizeService?.measure?.();
      } catch {
        /* options frozen / disposed */
      }
      lastCols = 0;
      lastRows = 0;
      scheduleFit({ immediate: true, forceRedraw: true });
    };

    const onFontsReady = () => {
      if (disposed) return;
      const fam = String(term.options.fontFamily || '')
        .split(',')[0]
        ?.replace(/['"]/g, '')
        .trim();
      const size = term.options.fontSize || 14;
      const loadP =
        fam && document.fonts?.load
          ? document.fonts.load(`${size}px "${fam}"`).catch(() => undefined)
          : Promise.resolve();
      void Promise.resolve(loadP).then(() => {
        if (!disposed) remeasureFontsAndFit();
      });
    };

    if (document.fonts?.ready) {
      void document.fonts.ready.then(onFontsReady);
    }
    // A late-loading face (or display=swap swap-in) can fire after ready.
    const onLoadingDone = () => {
      if (!disposed) remeasureFontsAndFit();
    };
    document.fonts?.addEventListener?.('loadingdone', onLoadingDone);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      document.fonts?.removeEventListener?.('loadingdone', onLoadingDone);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rafId) cancelAnimationFrame(rafId);
      if (fitRaf1) cancelAnimationFrame(fitRaf1);
      if (fitRaf2) cancelAnimationFrame(fitRaf2);
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('compositionstart', onCompositionStart, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
      for (const evt of ['keydown', 'keyup', 'pointerdown', 'pointerup'] as const) {
        document.removeEventListener(evt, onGestureForClipboard, gestureOpts);
      }
      pendingOsc52 = null;
      ro.disconnect();
      dataDisposable.dispose();
      osc52Disposable.dispose();
      try {
        canvasAddon?.dispose();
      } catch {
        /* already disposed with term */
      }
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
