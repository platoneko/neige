export type MarkdownHrefKind = 'external' | 'hash' | 'path' | 'ignore';

export function classifyMarkdownHref(
  href: string | null | undefined,
): MarkdownHrefKind {
  if (href == null) return 'ignore';
  const h = href.trim();
  if (!h) return 'ignore';
  if (h.startsWith('#')) return 'hash';
  // Protocol-relative or known external schemes
  if (
    h.startsWith('//') ||
    /^https?:/i.test(h) ||
    /^mailto:/i.test(h)
  ) {
    return 'external';
  }
  // Any other scheme: ignore (do not treat as path)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return 'ignore';
  return 'path';
}

export function stripHrefToPath(href: string): string {
  const noHash = href.split('#')[0] ?? '';
  const noQuery = noHash.split('?')[0] ?? '';
  return noQuery.trim();
}

export function dirnamePath(filePath: string): string {
  if (!filePath.includes('/')) return '.';
  const i = filePath.lastIndexOf('/');
  if (i === 0) return '/';
  if (i < 0) return '.';
  return filePath.slice(0, i) || '/';
}

export function basenamePath(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i < 0 ? filePath : filePath.slice(i + 1);
}

/** Posix join + normalize. If `rel` is absolute (starts with /), ignore baseDir. */
export function joinNormalize(baseDir: string, rel: string): string {
  const raw = rel.startsWith('/')
    ? rel
    : `${baseDir === '/' ? '' : baseDir}/${rel}`;
  const absolute = raw.startsWith('/');
  const parts = raw.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      // absolute: drop leading .. against root
      continue;
    }
    out.push(p);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

/**
 * Resolve a stripped path fragment relative to the currently viewed file.
 * Returns null if there is nothing to open.
 */
export function resolveMarkdownPath(
  currentFilePath: string,
  hrefPath: string,
): string | null {
  const stripped = stripHrefToPath(hrefPath);
  if (!stripped) return null;
  if (stripped.startsWith('/')) {
    // Absolute: normalize . / .. only (joinNormalize with base '/' works
    // when the second arg is absolute — see joinNormalize above).
    return joinNormalize('/', stripped);
  }
  return joinNormalize(dirnamePath(currentFilePath), stripped);
}
