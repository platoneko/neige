import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isImeHostFocused,
  writeClipboard,
  writeClipboardApiOnly,
  writeClipboardSync,
} from './clipboard';

// These tests lock in the BRANCHING of writeClipboard. The real failure modes
// (Radix focus trap stealing focus from a fallback textarea, Chrome on HTTP
// rejecting writeText asynchronously past the user gesture) only reproduce in
// a real browser — verify those on the device. Here we just make sure:
//   - secure context + async API present → use the async API
//   - insecure context (HTTP) → SKIP the async API entirely (no microtask gap)
//   - async API rejects → fall back to selection-based copy
//   - the selection-based fallback selects the right text on the document
//   - writeClipboardApiOnly never mutates Selection
//   - selectionCopy refuses while an IME host is focused

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
    // Chrome over HTTP still exposes navigator.clipboard.writeText, but it
    // rejects async. If we await it we lose the user-gesture window. Guard
    // on isSecureContext and go straight to the synchronous fallback.
    vi.stubGlobal('isSecureContext', false);
    const writeText = vi.fn().mockRejectedValue(new Error('insecure'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let copiedSelection = '';
    const exec = spyExec((cmd) => {
      if (cmd === 'copy') {
        copiedSelection = window.getSelection()?.toString() ?? '';
        return true;
      }
      return false;
    });

    await expect(writeClipboard('relative/path.ts')).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copiedSelection).toBe('relative/path.ts');
  });

  it('falls back to selection copy when writeText rejects in a secure context', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = spyExec(() => true);

    await expect(writeClipboard('x')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('selection fallback uses Range over an off-screen span, not a focused input', async () => {
    // The whole point of the selection-API fallback is that it survives Radix
    // FocusScope: nothing in the page needs to be focused.
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    spyExec(() => true);

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    await writeClipboard('absolute');

    // The fallback element should be a span, and we should never have called
    // focus() on it. (Saved-selection restoration may still focus other
    // elements; we only care that we don't depend on focus.)
    const spansCreatedAndRemoved = !document.querySelector('span'); // cleaned up
    expect(spansCreatedAndRemoved).toBe(true);
    const fallbackFocused = focusSpy.mock.instances.some(
      (el) => el instanceof HTMLElement && el.tagName === 'SPAN',
    );
    expect(fallbackFocused).toBe(false);
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

  it('writeClipboardSync refuses selectionCopy while a textarea is focused', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const exec = spyExec(() => true);

    expect(writeClipboardSync('must-not-copy')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('writeClipboardSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('uses selection copy immediately in an insecure context', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    let copied = '';
    spyExec((cmd) => {
      if (cmd === 'copy') {
        copied = window.getSelection()?.toString() ?? '';
        return true;
      }
      return false;
    });

    expect(writeClipboardSync('from-osc52')).toBe(true);
    expect(copied).toBe('from-osc52');
  });

  it('reports selectionCopy result even in a secure context (no false ok)', () => {
    // Fire-and-forget writeText must not make us claim success — OSC 52
    // queueing needs a truthful boolean so a denied write stays pending.
    vi.stubGlobal('isSecureContext', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    spyExec(() => false);

    expect(writeClipboardSync('held-for-gesture')).toBe(false);
    expect(writeText).toHaveBeenCalledWith('held-for-gesture');
  });

  it('returns true in a secure context when selectionCopy works', () => {
    vi.stubGlobal('isSecureContext', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let copied = '';
    spyExec((cmd) => {
      if (cmd === 'copy') {
        copied = window.getSelection()?.toString() ?? '';
        return true;
      }
      return false;
    });

    expect(writeClipboardSync('synced')).toBe(true);
    expect(copied).toBe('synced');
    expect(writeText).toHaveBeenCalledWith('synced');
  });
});
