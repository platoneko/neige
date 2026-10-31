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
  static latest: FakeWebSocket | null = null;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  constructor() {
    FakeWebSocket.latest = this;
  }
}

function ptyFrame(seq: bigint, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(8 + payload.byteLength);
  new DataView(buf).setBigUint64(0, seq);
  new Uint8Array(buf, 8).set(payload);
  return buf;
}

function asText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
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

describe('useTerminalCore alt-screen snapshot', () => {
  beforeEach(async () => {
    FakeWebSocket.latest = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // Flush the write buffer on the same turn so the snapshot follow-up
    // is observable without waiting on happy-dom's rAF clock.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
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
    FakeWebSocket.latest = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('wipes an alt-screen snapshot then closes synchronized output', async () => {
    // Grok full-repaints on SIGWINCH from a clean canvas; the wipe is that
    // clean canvas. OpenCode also needs CSI ?2026l or xterm 6 holds the
    // (now empty) paint after a truncated frame.
    const writes: string[] = [];
    const origWrite = term!.write.bind(term!);
    term!.write = ((data: string | Uint8Array, cb?: () => void) => {
      writes.push(asText(data));
      return origWrite(data, cb);
    }) as typeof term.write;

    const payload = new TextEncoder().encode('\x1b[?1049h\x1b[HHello TUI');
    const ws = FakeWebSocket.latest;
    expect(ws).not.toBeNull();

    await act(async () => {
      ws!.onmessage?.({ data: ptyFrame(0n, payload) });
      // xterm.js invokes write callbacks on a later turn.
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(writes.some((w) => w.includes('Hello TUI'))).toBe(true);
    expect(writes.some((w) => w.includes('\x1b[2J'))).toBe(true);
    expect(writes.some((w) => w.includes('\x1b[?2026l'))).toBe(true);
  });

  it('releases a synchronized-output latch left open by a truncated snapshot', async () => {
    // OpenCode wraps every frame in CSI ?2026h … 2026l. A seq=0 Snapshot is
    // a ring slice, so it often ends after 2026h and before 2026l. xterm 6
    // then holds the last paint (empty after reset) until 2026l arrives.
    const writes: string[] = [];
    const origWrite = term!.write.bind(term!);
    term!.write = ((data: string | Uint8Array, cb?: () => void) => {
      writes.push(asText(data));
      return origWrite(data, cb);
    }) as typeof term.write;

    const payload = new TextEncoder().encode('\x1b[?1049h\x1b[?2026hpartial frame');
    const ws = FakeWebSocket.latest;
    expect(ws).not.toBeNull();

    await act(async () => {
      ws!.onmessage?.({ data: ptyFrame(0n, payload) });
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(writes.some((w) => w.includes('\x1b[?2026l'))).toBe(true);
  });
});
