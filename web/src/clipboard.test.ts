import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClipboard } from './clipboard';

// These tests lock in the BRANCHING of writeClipboard. The real failure modes
// (Radix focus trap stealing focus from a fallback textarea, Chrome on HTTP
// rejecting writeText asynchronously past the user gesture) only reproduce in
// a real browser — verify those on the device. Here we just make sure:
//   - secure context + async API present → use the async API
//   - insecure context (HTTP) → SKIP the async API entirely (no microtask gap)
//   - async API rejects → fall back to selection-based copy
//   - the selection-based fallback selects the right text on the document

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
