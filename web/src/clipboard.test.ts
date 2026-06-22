import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeClipboard } from './clipboard';

// These guard the copy fallback used by copy-path / copy-contents. The real
// failure mode (iOS select() no-op, HTTP having no navigator.clipboard) can't
// be reproduced in a JS DOM env — verify that on a device. What we CAN lock in
// here is the branching: prefer the async API, otherwise drop to a synchronous
// execCommand copy with the text mounted in a selectable textarea.

function spyExec(impl: (cmd: string) => boolean) {
  if (typeof document.execCommand !== 'function') {
    (document as unknown as { execCommand: unknown }).execCommand = () => false;
  }
  return vi.spyOn(document, 'execCommand').mockImplementation(impl as never);
}

describe('writeClipboard', () => {
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

  it('falls back to execCommand when navigator.clipboard is absent (HTTP)', async () => {
    vi.stubGlobal('navigator', {}); // insecure context: no clipboard object
    let copiedFrom = '';
    const exec = spyExec((cmd) => {
      if (cmd === 'copy') {
        copiedFrom = document.querySelector('textarea')?.value ?? '';
        return true;
      }
      return false;
    });

    await expect(writeClipboard('relative/path.ts')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copiedFrom).toBe('relative/path.ts'); // text was mounted & selectable
    expect(document.querySelector('textarea')).toBeNull(); // and cleaned up
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const exec = spyExec(() => true);

    await expect(writeClipboard('x')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
