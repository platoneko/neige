import { useMemo } from 'react';
import type { RefObject } from 'react';
import { useTerminalCore } from '@neige/shared';

/**
 * Desktop-flavoured terminal hook. Thin wrapper over `useTerminalCore` that
 * layers on:
 *   - desktop theme + JetBrains-style mono font
 *   - Cmd+Arrow / Cmd+Backspace shortcuts so macOS doesn't eat them as
 *     history navigation
 *
 * Session activity is not computed here — it comes from the server on
 * `ConvInfo.activity`, so it exists for every session rather than only the
 * ones with a mounted terminal.
 */
export function useTerminal(containerId: string | null) {
  // The existing desktop markup uses `id={terminal-<convId>}` instead of
  // passing a ref around — build a synthetic ref that looks the element up
  // by id so the shared core (which expects a ref) keeps working without
  // touching TerminalPanel.tsx.
  const containerRef = useMemo<RefObject<HTMLDivElement | null>>(() => {
    return {
      get current() {
        if (!containerId) return null;
        return document.getElementById(
          `terminal-${containerId}`,
        ) as HTMLDivElement | null;
      },
      set current(_v) {
        // no-op — this ref is read-only by design
      },
    } as RefObject<HTMLDivElement | null>;
  }, [containerId]);

  // Full GitHub-dark ANSI palette. Important: `black` must match `background`.
  // After term.reset() on Snapshot reattach, xterm falls back to theme ANSI
  // colors (OSC 4 palette from session start has usually left the ring).
  // TUIs like Grok paint chrome with SGR 40 (ANSI black); pure #000000 on a
  // #0d1117 canvas reads as solid black blocks in the status/input bar.
  const theme = useMemo(
    () => ({
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      black: '#0d1117',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    }),
    [],
  );

  const { termRef, wsRef, fitRef, sendData } = useTerminalCore({
    containerRef,
    sessionId: containerId,
    theme,
    fontSize: 14,
    fontFamily:
      "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    onTerminalReady: (term) => {
      // Cmd+Left/Right → line start/end, Cmd+Backspace → kill line. The
      // browser swallows these by default (history nav), so intercept and
      // forward the equivalent control codes to the PTY. Goes through
      // sendData (binary frame), not raw ws.send(string) — the latter would
      // be dropped by the server as an unrecognized text control frame.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if (!e.metaKey || e.ctrlKey || e.altKey) return true;
        if (e.key === 'ArrowLeft') {
          sendData('\x01');
          e.preventDefault();
          return false;
        }
        if (e.key === 'ArrowRight') {
          sendData('\x05');
          e.preventDefault();
          return false;
        }
        if (e.key === 'Backspace') {
          sendData('\x15');
          e.preventDefault();
          return false;
        }
        return true;
      });
    },
  });

  return { termRef, wsRef, fitRef };
}
