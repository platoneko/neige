/**
 * OSC 52 arrival path. Grok copies on mouse release: the browser pointerup
 * fires first, then the OSC 52 frame comes back over the WS while Chrome's
 * transient activation from that release is still live. The copy must land
 * right then — not wait for the *next* gesture, which made the first
 * selection look like it never copied.
 */
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { useTerminalCore } from './useTerminalCore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

let term: Terminal | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useTerminalCore({
    containerRef,
    sessionId: 's1',
    onTerminalReady: (t) => {
      term = t;
    },
  });
  return <div ref={containerRef} />;
}

function writeOsc52(text: string): Promise<void> {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return new Promise((resolve) => term!.write(`\x1b]52;c;${b64}\x07`, resolve));
}

/** Simulates a browser that honors execCommand('copy') right now. */
function captureCopies(): string[] {
  const copied: string[] = [];
  vi.spyOn(document, 'execCommand').mockImplementation(((cmd: string) => {
    if (cmd !== 'copy') return false;
    const dt = new DataTransfer();
    document.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    copied.push(dt.getData('text/plain'));
    return true;
  }) as never);
  return copied;
}

describe('useTerminalCore OSC 52', () => {
  beforeEach(async () => {
    // Plain HTTP: no Clipboard API, so only the copy-event path can land it.
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    if (typeof document.execCommand !== 'function') {
      (document as unknown as { execCommand: unknown }).execCommand = () => false;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    term = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lands the copy on arrival without waiting for another gesture', async () => {
    const copied = captureCopies();

    await writeOsc52('hello grok');

    expect(copied).toEqual(['hello grok']);
  });

  it('does not copy again on the next gesture once landed', async () => {
    const copied = captureCopies();

    await writeOsc52('once');
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(copied).toEqual(['once']);
  });

  it('keeps the payload staged when arrival copy is refused', async () => {
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(false);

    await writeOsc52('later');
    const copied = captureCopies();
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(exec).toHaveBeenCalled();
    expect(copied).toEqual(['later']);
  });

  it('defers to the next gesture while an IME composition is open', async () => {
    const copied = captureCopies();
    document.dispatchEvent(new CompositionEvent('compositionstart'));

    await writeOsc52('中文');
    expect(copied).toEqual([]);

    document.dispatchEvent(new CompositionEvent('compositionend'));
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(copied).toEqual(['中文']);
  });
});
