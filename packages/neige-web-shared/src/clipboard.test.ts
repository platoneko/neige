import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  eventCopy,
  isImeHostFocused,
  writeClipboard,
  writeClipboardApiOnly,
  writeClipboardSync,
} from './clipboard';

// Branching tests for clipboard helpers. Real browser gesture / IME
// interaction still needs a manual check on the device.

function spyExec(impl: (cmd: string) => boolean) {
  if (typeof document.execCommand !== 'function') {
    (document as unknown as { execCommand: unknown }).execCommand = () => false;
  }
  return vi.spyOn(document, 'execCommand').mockImplementation(impl as never);
}

describe('writeClipboard', () => {
  beforeEach(() => {
    vi.stubGlobal('isSecureContext', true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the async Clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = spyExec(() => true);

    await expect(writeClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips the async API entirely in an insecure context (HTTP)', async () => {
    vi.stubGlobal('isSecureContext', false);
    const writeText = vi.fn().mockRejectedValue(new Error('insecure'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let viaEvent = '';
    const exec = spyExec((cmd) => {
      if (cmd === 'copy') {
        // Simulate browser firing the copy event for eventCopy.
        document.dispatchEvent(
          new ClipboardEvent('copy', {
            clipboardData: new DataTransfer(),
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      }
      return false;
    });
    // Real eventCopy listens for copy; wire DataTransfer through a spy.
    const setData = vi.fn();
    vi.spyOn(document, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'copy' && typeof handler === 'function') {
        const e = {
          clipboardData: { setData },
          preventDefault: vi.fn(),
        };
        // call handler when execCommand runs
        spyExec((cmd) => {
          if (cmd === 'copy') {
            (handler as (ev: unknown) => void)(e);
            viaEvent = 'ok';
            return true;
          }
          return false;
        });
      }
    });

    // Simpler path: mock eventCopy success by making exec + handler work
    vi.restoreAllMocks();
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const setData2 = vi.fn();
    document.addEventListener = vi.fn((type: string, handler: EventListener) => {
      if (type === 'copy') {
        (document as unknown as { __copyHandler?: EventListener }).__copyHandler = handler;
      }
    }) as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec((cmd) => {
      if (cmd === 'copy') {
        const h = (document as unknown as { __copyHandler?: EventListener }).__copyHandler;
        h?.({
          clipboardData: { setData: setData2 },
          preventDefault: () => {},
        } as unknown as Event);
        return true;
      }
      return false;
    });

    await expect(writeClipboard('relative/path.ts')).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(setData2).toHaveBeenCalledWith('text/plain', 'relative/path.ts');
    void viaEvent;
    void exec;
  });

  it('falls back when writeText rejects in a secure context', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const setData = vi.fn();
    document.addEventListener = vi.fn((type: string, handler: EventListener) => {
      if (type === 'copy') {
        (document as unknown as { __copyHandler?: EventListener }).__copyHandler = handler;
      }
    }) as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec((cmd) => {
      if (cmd === 'copy') {
        const h = (document as unknown as { __copyHandler?: EventListener }).__copyHandler;
        h?.({
          clipboardData: { setData },
          preventDefault: () => {},
        } as unknown as Event);
        return true;
      }
      return false;
    });

    await expect(writeClipboard('x')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(setData).toHaveBeenCalledWith('text/plain', 'x');
  });
});

describe('eventCopy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('supplies text via the copy event without touching Selection', () => {
    const setData = vi.fn();
    const removeSpy = vi.spyOn(Selection.prototype, 'removeAllRanges');
    document.addEventListener = vi.fn((type: string, handler: EventListener) => {
      if (type === 'copy') {
        (document as unknown as { __h?: EventListener }).__h = handler;
      }
    }) as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec((cmd) => {
      if (cmd === 'copy') {
        (document as unknown as { __h?: EventListener }).__h?.({
          clipboardData: { setData },
          preventDefault: () => {},
        } as unknown as Event);
        return true;
      }
      return false;
    });

    expect(eventCopy('hello-osc')).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'hello-osc');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('returns false when execCommand fails', () => {
    document.addEventListener = vi.fn() as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec(() => false);
    expect(eventCopy('nope')).toBe(false);
  });
});

describe('writeClipboardApiOnly', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes via Clipboard API and never calls execCommand', async () => {
    vi.stubGlobal('isSecureContext', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = spyExec(() => true);

    await expect(writeClipboardApiOnly('osc-payload')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('osc-payload');
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns false in an insecure context without touching Selection', async () => {
    vi.stubGlobal('isSecureContext', false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = spyExec(() => true);
    const removeSpy = vi.spyOn(Selection.prototype, 'removeAllRanges');

    await expect(writeClipboardApiOnly('nope')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('returns false when writeText rejects (no selection fallthrough)', async () => {
    vi.stubGlobal('isSecureContext', true);
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = spyExec(() => true);

    await expect(writeClipboardApiOnly('denied')).resolves.toBe(false);
    expect(writeText).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('isImeHostFocused / selectionCopy guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('detects textarea focus as an IME host', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(isImeHostFocused()).toBe(true);
  });

  it('writeClipboardSync prefers eventCopy even with textarea focused', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();

    const setData = vi.fn();
    document.addEventListener = vi.fn((type: string, handler: EventListener) => {
      if (type === 'copy') {
        (document as unknown as { __h?: EventListener }).__h = handler;
      }
    }) as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec((cmd) => {
      if (cmd === 'copy') {
        (document as unknown as { __h?: EventListener }).__h?.({
          clipboardData: { setData },
          preventDefault: () => {},
        } as unknown as Event);
        return true;
      }
      return false;
    });

    expect(writeClipboardSync('from-terminal-pointer')).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'from-terminal-pointer');
    // Never blurred — focus stayed on the textarea.
    expect(document.activeElement).toBe(ta);
  });

  it('Range fallback with yieldImeHost blurs, copies, restores', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();

    // Force eventCopy to fail so we hit selectionCopy.
    document.addEventListener = vi.fn() as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    let copied = '';
    let phase = 0;
    spyExec((cmd) => {
      // first call is eventCopy → fail; second is selectionCopy → ok
      if (cmd === 'copy') {
        phase += 1;
        if (phase === 1) return false;
        expect(document.activeElement).not.toBe(ta);
        copied = window.getSelection()?.toString() ?? '';
        return true;
      }
      return false;
    });

    expect(writeClipboardSync('fallback', { yieldImeHost: true })).toBe(true);
    expect(copied).toBe('fallback');
    expect(document.activeElement).toBe(ta);
  });
});

describe('writeClipboardSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('uses eventCopy in an insecure context', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    const setData = vi.fn();
    document.addEventListener = vi.fn((type: string, handler: EventListener) => {
      if (type === 'copy') {
        (document as unknown as { __h?: EventListener }).__h = handler;
      }
    }) as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec((cmd) => {
      if (cmd === 'copy') {
        (document as unknown as { __h?: EventListener }).__h?.({
          clipboardData: { setData },
          preventDefault: () => {},
        } as unknown as Event);
        return true;
      }
      return false;
    });

    expect(writeClipboardSync('from-osc52')).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'from-osc52');
  });

  it('reports failure when both eventCopy and selectionCopy fail', () => {
    vi.stubGlobal('isSecureContext', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    document.addEventListener = vi.fn() as unknown as typeof document.addEventListener;
    document.removeEventListener = vi.fn() as unknown as typeof document.removeEventListener;
    spyExec(() => false);

    expect(writeClipboardSync('held-for-gesture')).toBe(false);
    expect(writeText).toHaveBeenCalledWith('held-for-gesture');
  });
});
