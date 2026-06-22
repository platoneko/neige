// Clipboard helper shared across the UI.
//
// The async Clipboard API only exists in a secure context (HTTPS or localhost).
// neige is frequently reached over plain HTTP — e.g. across WireGuard/Tailscale
// by IP — where `navigator.clipboard` is undefined. In that case we fall back
// to a legacy execCommand copy that also handles the iOS Safari quirk where
// textarea.select() is a no-op.

export async function writeClipboard(text: string): Promise<boolean> {
  // Prefer the async API when present; also fall back when writeText rejects
  // (permission denied, document not focused, …).
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to legacy copy */
    }
  }
  return legacyCopy(text);
}

// execCommand-based copy for insecure (HTTP) contexts. Must run synchronously
// inside the user gesture (e.g. a dropdown's onSelect) for the browser to honor it.
function legacyCopy(text: string): boolean {
  const restoreFocus = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  // readonly stops iOS from popping the keyboard but still allows selection.
  ta.setAttribute('readonly', '');
  // Keep it in the layout but out of sight. Avoid display:none / opacity:0,
  // which can stop some browsers from copying the selection.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = '0';
  ta.style.fontSize = '16px'; // avoids iOS zoom-to-focus
  document.body.appendChild(ta);

  let ok = false;
  try {
    ta.focus();
    ta.select();
    // iOS Safari ignores textarea.select(); setSelectionRange is what actually
    // selects the value there.
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  ta.remove();
  // Hand focus back to whatever had it (e.g. the dropdown trigger).
  restoreFocus?.focus?.();
  return ok;
}
