// Clipboard helper shared across the UI and the embedded terminal (OSC 52).
//
// Why `navigator.clipboard.writeText` alone is not enough:
//
// 1) neige is frequently reached over plain HTTP (WireGuard/LAN by IP). The
//    document is an insecure context: Chrome still exposes the API but
//    `writeText` rejects. We gate on `window.isSecureContext`.
//
// 2) OSC 52 from a TUI has no browser user-gesture when it arrives. Callers
//    stage the payload and retry on the next gesture.
//
// 3) CJK IME: mutating `window.getSelection()` (or blur/focus thrash) while
//    the xterm textarea is focused cancels composition. Prefer the
//    copy-event interceptor below — it never touches Selection or focus.
//
// Sync path under a user gesture (pointer/key):
//   a) copy-event + execCommand('copy')  — no Selection, no blur (HTTP OK)
//   b) selection Range fallback          — for environments that require it
//   c) Clipboard API only when secure    — async, fire-and-forget in sync API

export type SelectionCopyOptions = {
  /**
   * When an IME host is focused and we must fall back to Range selection:
   * blur → copy → restore. Prefer eventCopy which does not need this.
   * Default false = refuse the Range path while an IME host is focused.
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
  if (ae.classList.contains('xterm-helper-textarea')) return true;
  return false;
}

/**
 * Clipboard API only — never mutates Selection or focus.
 * Safe from keyboard handlers and OSC 52 arrival (no user gesture required
 * for the call itself; the API still needs a secure context + permission).
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
 * Install a one-shot `copy` handler that feeds `text` into clipboardData,
 * then fire `document.execCommand('copy')`.
 *
 * Does not mutate Selection or focus — safe next to CJK IME and required
 * under a real user gesture on plain HTTP.
 */
export function eventCopy(text: string): boolean {
  let supplied = false;
  const onCopy = (e: ClipboardEvent) => {
    try {
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
      supplied = true;
    } catch {
      supplied = false;
    }
  };
  document.addEventListener('copy', onCopy);
  let invoked = false;
  try {
    invoked = document.execCommand('copy');
  } catch {
    invoked = false;
  }
  document.removeEventListener('copy', onCopy);
  return invoked && supplied;
}

/**
 * UI buttons/menus: Clipboard API when secure, else gesture-safe fallbacks.
 * May touch Selection only if eventCopy fails.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  if (eventCopy(text)) return true;
  return selectionCopy(text);
}

/**
 * Synchronous path for an existing user gesture (OSC 52 pointer/key flush).
 *
 * Return value is truthful: only sync paths can confirm success here.
 * Order: eventCopy (IME-safe) → optional Range selection → never claim
 * success from a fire-and-forget Clipboard API call.
 */
export function writeClipboardSync(
  text: string,
  opts?: SelectionCopyOptions,
): boolean {
  if (eventCopy(text)) {
    // Best-effort sticky grant on https; ignore result.
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
    return true;
  }
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
  return selectionCopy(text, opts);
}

function selectionCopy(text: string, opts?: SelectionCopyOptions): boolean {
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
  const savedRanges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) savedRanges.push(selection.getRangeAt(i));
  }

  const span = document.createElement('span');
  span.textContent = text;
  span.style.position = 'fixed';
  span.style.top = '0';
  span.style.left = '0';
  span.style.width = '1px';
  span.style.height = '1px';
  span.style.padding = '0';
  span.style.opacity = '0';
  span.style.pointerEvents = 'none';
  span.style.whiteSpace = 'pre';
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
  restore?.focus({ preventScroll: true });
  return ok;
}
