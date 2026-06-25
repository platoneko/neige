// Clipboard helper shared across the UI.
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

function selectionCopy(text: string): boolean {
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
  return ok;
}
