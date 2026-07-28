import { useRef, useState } from 'react';
import { useTerminalCore } from '@neige/shared/useTerminalCore';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// Cool-neutral light xterm theme matching Calm's palette.
const LIGHT_THEME: ITheme = {
  background: '#ffffff00',          // transparent — card body shows through
  foreground: '#2a2f3a',
  cursor: '#2a2f3a',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(60, 100, 200, 0.22)',
  black:    '#1a1d22',
  red:      '#c43b3b',
  green:    '#2f8c3c',
  yellow:   '#a07a14',
  blue:     '#3464c2',
  magenta:  '#8b3b9a',
  cyan:     '#2a8a8a',
  white:    '#d9dbe0',
  brightBlack:   '#5b626d',
  brightRed:     '#e0625b',
  brightGreen:   '#4faa5e',
  brightYellow:  '#c89a30',
  brightBlue:    '#5c87d8',
  brightMagenta: '#aa5cb8',
  brightCyan:    '#4cb0b0',
  brightWhite:   '#f6f7f9',
};

const DARK_THEME: ITheme = {
  ...LIGHT_THEME,
  background: '#ffffff00',
  foreground: '#d8dbe2',
  cursor: '#d8dbe2',
  selectionBackground: 'rgba(140, 180, 255, 0.22)',
};

interface XtermViewProps {
  convId: string;
  theme?: 'light' | 'dark';
}

/**
 * Renders a live PTY inside a card body. Wraps `useTerminalCore` from
 * `@neige/shared` — the same protocol web/ and web-mobile/ use — so reconnect,
 * resize and scrollback all behave identically.
 */
export function XtermView({ convId, theme = 'light' }: XtermViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'reconnecting'>('connecting');

  useTerminalCore({
    containerRef,
    sessionId: convId,
    theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
    fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
    fontSize: 12.5,
    onStatusChange: setStatus,
  });

  return (
    <div className="xterm-view">
      <div ref={containerRef} className="xterm-container" />
      {status !== 'open' && (
        <div className="xterm-status">{status}…</div>
      )}
    </div>
  );
}
