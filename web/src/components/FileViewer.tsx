import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import { DropdownMenu } from '@radix-ui/themes';
import { authedFetch, fileUrl as buildFileUrl } from '../api';
import { writeClipboard } from '../clipboard';
import {
  MarkdownToc,
  stripInlineMarkdown,
  tocHeadingId,
  type TocHeading,
  type TocLevel,
} from './MarkdownToc';

// Render markdown with h1–h4 headings tagged `id="md-h-N"` in document order,
// and collect a parallel `headings` list the TOC can render off of. Deriving
// both from a single marked pass keeps the DOM ids and the TOC entries aligned
// on edge cases where a standalone regex extractor would drift (headings
// inside blockquotes, unusual inline formatting, etc.).
function renderMarkdownWithToc(source: string): {
  html: string;
  headings: TocHeading[];
} {
  const headings: TocHeading[] = [];
  const m = new Marked({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens) as string;
        if (token.depth >= 1 && token.depth <= 4) {
          const id = tocHeadingId(headings.length);
          const text = stripInlineMarkdown(token.text) || token.text.trim();
          headings.push({
            level: token.depth as TocLevel,
            text,
            id,
          });
          return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
        }
        return `<h${token.depth}>${inner}</h${token.depth}>\n`;
      },
    },
  });
  const html = m.parse(source) as string;
  return { html, headings };
}

interface FileViewerProps {
  filePath: string;
  // Base directory for the "Copy relative path" action (typically the
  // owning conversation's effective_cwd at the time the file was opened).
  baseCwd?: string;
}

function relativeUnder(base: string | undefined, abs: string): string | null {
  if (!base) return null;
  if (abs === base) return '.';
  const prefix = base.endsWith('/') ? base : base + '/';
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length);
}

interface PathMenuProps {
  filePath: string;
  relPath: string | null;
  copied: 'absolute' | 'relative' | null;
  onCopy: (which: 'absolute' | 'relative') => void;
}

function PathMenu({ filePath, relPath, copied, onCopy }: PathMenuProps) {
  const display = relPath ?? filePath;
  // Copy-feedback wins over the normal label so the click feels acknowledged.
  const label = copied === 'absolute'
    ? 'Copied path'
    : copied === 'relative'
      ? 'Copied relative path'
      : display;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button
          type="button"
          className={`file-viewer-path${copied ? ' is-copied' : ''}`}
          title={filePath}
          aria-label="Copy path"
        >
          <span className="file-viewer-path-text">{label}</span>
          <span className="file-viewer-path-caret" aria-hidden>▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1" align="start">
        <DropdownMenu.Item onSelect={() => onCopy('absolute')}>
          Copy path
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => onCopy('relative')}
          disabled={!relPath}
        >
          Copy relative path
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng',
]);

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return '';
  return path.slice(i + 1).toLowerCase();
}

// The ETag header comes wrapped in quotes per RFC; strip them for use in URLs.
function normalizeEtag(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^"/, '').replace(/"$/, '');
}

export function FileViewer({ filePath, baseCwd }: FileViewerProps) {
  const ext = extOf(filePath);
  const isImage = IMAGE_EXTS.has(ext);
  const fileUrl = buildFileUrl(filePath);
  const relPath = useMemo(() => relativeUnder(baseCwd, filePath), [baseCwd, filePath]);

  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('text');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!isImage);
  const [copied, setCopied] = useState(false);
  // Transient feedback for the path dropdown ("Copied path" / "Copied relative path").
  const [pathCopied, setPathCopied] = useState<'absolute' | 'relative' | null>(null);
  // ETag of the file state the preview currently reflects. Drives the image
  // cache-bust query param and the HEAD-diff check on tab revisit.
  const [etag, setEtag] = useState<string | null>(null);
  // TOC sidebar state — deliberately not persisted; it's a "reading-this-file"
  // affordance, not a global preference.
  const [tocCollapsed, setTocCollapsed] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const paneContainerRef = useRef<HTMLDivElement | null>(null);

  const isMarkdown = language === 'markdown';

  const { html: markdownHtml, headings } = useMemo(
    () =>
      isMarkdown
        ? renderMarkdownWithToc(content)
        : { html: '', headings: [] as TocHeading[] },
    [isMarkdown, content],
  );

  const loadText = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await authedFetch(fileUrl);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setEtag(r.headers.get('etag'));
      const data = (await r.json()) as { content: string; language: string };
      setContent(data.content);
      setLanguage(data.language);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fileUrl]);

  // HEAD with cache:'no-store' so the browser itself doesn't serve us a stale
  // ETag and hide real file changes from the diff check.
  const fetchEtag = useCallback(async (): Promise<string | null> => {
    try {
      const r = await authedFetch(fileUrl, { method: 'HEAD', cache: 'no-store' });
      if (r.ok) return r.headers.get('etag');
    } catch { /* ignore */ }
    return null;
  }, [fileUrl]);

  // Initial load. For text we need the body; for images we only need the ETag
  // so the <img> URL carries the correct cache-busting version from the start.
  useEffect(() => {
    setEtag(null);
    if (isImage) {
      fetchEtag().then((e) => { if (e) setEtag(e); });
    } else {
      loadText();
    }
  }, [fileUrl, isImage, loadText, fetchEtag]);

  // Manual refresh. Text: refetch content unconditionally. Image: refresh the
  // ETag; if it changed, the src changes and the browser refetches. If the
  // file hasn't actually changed, we intentionally keep the cached image.
  const handleRefresh = useCallback(async () => {
    if (isImage) {
      const e = await fetchEtag();
      if (e) setEtag(e);
    } else {
      await loadText();
    }
  }, [isImage, loadText, fetchEtag]);

  // Auto-refresh on tab revisit, but only when the file actually changed.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const newEtag = await fetchEtag();
      if (!newEtag || newEtag === etag) return;
      setEtag(newEtag);
      if (!isImage) await loadText();
      // For images, the etag change above flips the <img> src and the
      // browser refetches on its own.
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [etag, isImage, loadText, fetchEtag]);

  const handleCopy = async () => {
    if (await writeClipboard(content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleCopyPath = useCallback(async (which: 'absolute' | 'relative') => {
    const text = which === 'relative' ? (relPath ?? filePath) : filePath;
    if (await writeClipboard(text)) {
      setPathCopied(which);
      setTimeout(() => setPathCopied(null), 1500);
    }
  }, [filePath, relPath]);

  useEffect(() => {
    if (!isMarkdown || headings.length === 0) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const container = paneContainerRef.current;
    if (!container) return;
    // Use the nearest scrollable ancestor as the observer root so `rootMargin`
    // is measured against the actual viewport of the preview.
    const scroller = container.closest('.file-viewer-content');
    const nodes = Array.from(
      container.querySelectorAll<HTMLElement>('[id^="md-h-"]'),
    );
    if (nodes.length === 0) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        if (visible.size === 0) {
          setActiveHeadingId(null);
          return;
        }
        // Pick the DOM-first among visible so the highlight is stable when
        // more than one heading sits inside the activation band.
        const first = nodes.find((n) => visible.has(n.id));
        setActiveHeadingId(first?.id ?? null);
      },
      {
        root: scroller instanceof HTMLElement ? scroller : null,
        rootMargin: '0px 0px -70% 0px',
        threshold: 0,
      },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [isMarkdown, headings, markdownHtml]);

  const handleTocSelect = useCallback((h: TocHeading) => {
    const container = paneContainerRef.current;
    if (!container) return;
    // Scope the id lookup to this pane so multiple FileViewers on screen
    // wouldn't race for the same `md-h-N`.
    const target = container.querySelector<HTMLElement>(`[id="${h.id}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleToggleToc = useCallback(() => {
    setTocCollapsed((c) => !c);
  }, []);

  if (isImage) {
    const cacheKey = normalizeEtag(etag);
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <PathMenu filePath={filePath} relPath={relPath} copied={pathCopied} onCopy={handleCopyPath} />
          <span className="file-viewer-lang">{ext}</span>
          <button
            className="file-viewer-copy"
            onClick={handleRefresh}
            title="Reload image from disk"
          >
            Refresh
          </button>
        </div>
        <div className="file-viewer-content file-viewer-content-image">
          {cacheKey ? (
            <img
              className="file-viewer-image"
              src={`${fileUrl}&v=${encodeURIComponent(cacheKey)}`}
              alt={filePath}
              onError={() => setError('failed to load image')}
            />
          ) : (
            <div className="file-viewer-loading">Loading...</div>
          )}
          {error && <div className="file-viewer-error">{error}</div>}
        </div>
      </div>
    );
  }

  if (loading && !content) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">Loading...</div>
      </div>
    );
  }

  if (error && !content) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-error">Failed to load file: {error}</div>
      </div>
    );
  }

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <PathMenu filePath={filePath} relPath={relPath} copied={pathCopied} onCopy={handleCopyPath} />
        <span className="file-viewer-lang">{language}</span>
        <button
          className="file-viewer-copy"
          onClick={handleRefresh}
          title="Reload file from disk"
        >
          Refresh
        </button>
        <button
          className="file-viewer-copy"
          onClick={handleCopy}
          title="Copy full contents"
          disabled={!content}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="file-viewer-content">
        {isMarkdown ? (
          <div className="file-viewer-markdown-wrap">
            <div
              className="file-viewer-markdown"
              ref={paneContainerRef}
              dangerouslySetInnerHTML={{ __html: markdownHtml }}
            />
            {headings.length > 0 && (
              <MarkdownToc
                headings={headings}
                activeId={activeHeadingId}
                collapsed={tocCollapsed}
                onToggleCollapsed={handleToggleToc}
                onSelect={handleTocSelect}
              />
            )}
          </div>
        ) : (
          <pre className="file-viewer-code">
            <code>{content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
