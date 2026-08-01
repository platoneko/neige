// Clipboard helper shared across the UI and the embedded terminal (OSC 52).
//
// Two reasons the obvious `navigator.clipboard.writeText` path isn't enough:
//
// 1) neige is frequently reached over plain HTTP (WireGuard/LAN by IP), where
//    the document is an insecure context. In Chrome the API still EXISTS but
//    `writeText` rejects asynchronously — by the time we catch the rejection
//    and fall back, we're a microtask past the user gesture and `execCommand`
//    also refuses. So we gate on `window.isSecureContext` and skip the async
//    path entirely, keeping the legacy copy synchronous inside the gesture.
//
// 2) The fallback runs inside Radix `DropdownMenu` (Copy path), whose
//    FocusScope traps focus inside the portal. A textarea+focus+select copy
//    fails there because Radix steals focus back the instant we focus the
//    textarea, leaving execCommand nothing focused to copy from. Instead we
//    drive the document Selection directly with a Range over an off-screen
//    span — the selection lives on the document, not on a focused element,
//    so the focus trap can't break it.
//
// OSC 52 from a TUI has no browser user-gesture at all. Callers that care
// (the terminal core) should queue failed writes and retry on the next
// user gesture. Keyboard / mid-composition must never run selectionCopy
// (mutates Selection → cancels CJK IME). Pointer gestures may use
// selectionCopy with `yieldImeHost: true`, which blurs the xterm textarea
// for the copy then restores focus — required on HTTP where the Clipboard
// API is unavailable, without leaving Selection desynced while the host
// stays focused.

export type SelectionCopyOptions = {
  /**
   * When an IME host (textarea / xterm helper / …) is focused: blur it,
   * run the selection copy, then restore focus. Default false = refuse
   * without mutating Selection (safe accidental call). OSC pointer flush
   * passes true so plain-HTTP copies still land.
   */
  yieldImeHost?: boolean;
};

/** True when focus is on an element that hosts CJK IME composition. */
export function isImeHostFocused(): boolean {
  const ae = document.activeElement;
  if (!ae || !(ae instanceof HTMLElement)) return false;
  if (ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement) {
    return true;
  }
  if (ae.isContentEditable) return true;
  // xterm.js input surface
  if (ae.classList.contains('xterm-helper-textarea')) return true;
  return false;
}

/**
 * Clipboard API only — never mutates document Selection.
 * Safe to call from keyboard handlers and OSC 52 arrival (no user gesture).
 * Returns false on insecure contexts, missing API, or rejection.
 */
export async function writeClipboardApiOnly(text: string): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preferred for UI buttons/menus: Clipboard API when secure, else selection
 * fallback. Not safe mid-IME-composition (selection fallback mutates
 * Selection) — use writeClipboardApiOnly from terminal keyboard/OSC-arrival
 * paths. Pointer flushes should use writeClipboardSync({ yieldImeHost: true }).
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to selection-based copy */
    }
  }
  return selectionCopy(text);
}

/**
 * Synchronous path used when we already hold a user gesture (or want to
 * avoid microtask gaps).
 *
 * Return value is truthful: only `selectionCopy` can confirm success inside
 * this call. The Clipboard API is always async, so we never treat a fired
 * `writeText` as done — OSC 52 queueing depends on a real boolean, and a
 * false "ok" would drop the only copy of the text.
 *
 * On https we still kick `writeText` in parallel: some browsers honor a
 * sticky clipboard permission without going through selection, and the
 * extra write is harmless when selectionCopy already worked.
 *
 * Pass `yieldImeHost: true` from pointer-gesture OSC flush so selection
 * copy works while the xterm textarea is focused (blur → copy → restore).
 * Default refuses while an IME host is focused so accidental callers don't
 * kill CJK input.
 */
export function writeClipboardSync(
  text: string,
  opts?: SelectionCopyOptions,
): boolean {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* ignore — selectionCopy result is authoritative */
    });
  }
  return selectionCopy(text, opts);
}

function selectionCopy(text: string, opts?: SelectionCopyOptions): boolean {
  // Mutating Selection while a textarea keeps focus desyncs CJK IME
  // (fcitx/Chromium). Either refuse, or briefly yield focus for the copy.
  let restore: HTMLElement | null = null;
  if (isImeHostFocused()) {
    if (!opts?.yieldImeHost) return false;
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) {
      restore = ae;
      restore.blur();
    }
  }

  const selection = window.getSelection();
  // Preserve any selection the user had so we don't trash it on failure.
  const savedRanges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) savedRanges.push(selection.getRangeAt(i));
  }

  const span = document.createElement('span');
  span.textContent = text;
  // Keep it on-screen-but-invisible. display:none / visibility:hidden would
  // also hide it from Selection; opacity:0 with a real layout box is the
  // standard trick.
  span.style.position = 'fixed';
  span.style.top = '0';
  span.style.left = '0';
  span.style.width = '1px';
  span.style.height = '1px';
  span.style.padding = '0';
  span.style.opacity = '0';
  span.style.pointerEvents = 'none';
  span.style.whiteSpace = 'pre';
  // Allow selection regardless of inherited `user-select: none` on the page.
  span.style.userSelect = 'text';
  (span.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'text';
  document.body.appendChild(span);

  let ok = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(span);
    selection?.removeAllRanges();
    selection?.addRange(range);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  selection?.removeAllRanges();
  for (const r of savedRanges) selection?.addRange(r);
  span.remove();

  // Restore terminal focus so the next keystroke still reaches xterm.
  // preventScroll avoids jumping the page when the helper textarea refocuses.
  restore?.focus({ preventScroll: true });
  return ok;
}
