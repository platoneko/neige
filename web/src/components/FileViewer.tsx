import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Marked } from 'marked';
import { DropdownMenu } from '@radix-ui/themes';
import { authedFetch, fileUrl as buildFileUrl } from '../api';
import { writeClipboard } from '../clipboard';
import { useOpenFile } from '../OpenFileContext';
import {
  basenamePath,
  classifyMarkdownHref,
  resolveMarkdownPath,
} from '../markdownLinks';
import { SearchBar, createSearchAdapter, type SearchAdapter } from './FileSearch';
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
  // The body of whichever pane is showing — the rendered markdown or the
  // <pre>. Also the root for in-file search, which is why it deliberately
  // excludes the TOC: heading text must not count as matches.
  const paneContainerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // In-file search. Not persisted anywhere: it's a "reading this file right
  // now" affordance, and a stale query surfacing on the next open would be
  // more surprising than helpful.
  const [barOpen, setBarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchCurrent, setMatchCurrent] = useState(0);
  const [matchTotal, setMatchTotal] = useState(0);
  const adapterRef = useRef<SearchAdapter | null>(null);
  const barInputRef = useRef<HTMLInputElement | null>(null);

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

  const openFile = useOpenFile();

  const handleMarkdownClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Only plain left-clicks
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!anchor || !(anchor instanceof HTMLAnchorElement)) return;
      // Stay within this pane (ignore if somehow outside)
      if (!e.currentTarget.contains(anchor)) return;

      const raw = anchor.getAttribute('href');
      const kind = classifyMarkdownHref(raw);

      if (kind === 'ignore') {
        e.preventDefault();
        return;
      }
      if (kind === 'hash') {
        e.preventDefault();
        return;
      }
      if (kind === 'external') {
        e.preventDefault();
        if (raw) window.open(raw, '_blank', 'noopener,noreferrer');
        return;
      }
      // path
      e.preventDefault();
      if (!raw) return;
      const abs = resolveMarkdownPath(filePath, raw);
      if (!abs) return;
      const name = basenamePath(abs) || abs;
      openFile?.(abs, name, baseCwd);
    },
    [filePath, baseCwd, openFile],
  );

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

  // Both panes report through one ref, so the search effect below doesn't have
  // to know which one is mounted.
  const setPaneContainer = useCallback((el: HTMLElement | null) => {
    paneContainerRef.current = el;
  }, []);

  // Write markdown HTML ourselves instead of `dangerouslySetInnerHTML`.
  // React 19 diffs that prop by object identity and, on any new `{ __html }`
  // reference, reassigns `element.innerHTML` even when the string is unchanged
  // — which destroys text nodes and collapses CSS Custom Highlight Ranges.
  // Memoizing the prop object is easy to regress; a layout effect that only
  // runs when the HTML string changes never rewrites the tree on search
  // keystrokes, match-index updates, or TOC scrollspy.
  useLayoutEffect(() => {
    if (!isMarkdown) return;
    const el = paneContainerRef.current;
    if (!el) return;
    el.innerHTML = markdownHtml;
  }, [isMarkdown, markdownHtml]);

  const closeSearch = useCallback(() => {
    setBarOpen(false);
    setSearchQuery('');
    adapterRef.current?.setQuery('');
    setMatchCurrent(0);
    setMatchTotal(0);
    contentRef.current?.focus({ preventScroll: true });
  }, []);

  // A new file starts from a clean slate; clearing the query drops the
  // highlights and zeroes the counter through the effect below. Adjusting
  // during render rather than in an effect so the bar never paints once
  // against the wrong file.
  const [searchedFile, setSearchedFile] = useState(filePath);
  if (searchedFile !== filePath) {
    setSearchedFile(filePath);
    setBarOpen(false);
    setSearchQuery('');
  }

  // Rebuild the adapter only when the pane's DOM is replaced (markdown↔source,
  // refresh, on-disk content change). Ranges point at text nodes, so a new
  // tree needs a fresh collect — but keystrokes must NOT tear the adapter
  // down: dispose/recreate on every `searchQuery` change races with next/prev
  // and with the paint path that depends on stable Range targets.
  useEffect(() => {
    const container = paneContainerRef.current;
    if (!container) return;
    const adapter = createSearchAdapter(container, contentRef.current, (current, total) => {
      setMatchCurrent(current);
      setMatchTotal(total);
    });
    adapterRef.current = adapter;
    adapter.setQuery(searchQuery);
    return () => {
      adapter.dispose();
      adapterRef.current = null;
    };
    // searchQuery is read only for the initial apply after a DOM rebuild; live
    // keystrokes go through handleSearchChange → adapter.setQuery.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [isMarkdown, markdownHtml, content]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    adapterRef.current?.setQuery(value);
  }, []);

  // Focus the pane so `/` works without a click first — but only when nothing
  // else holds focus. Opening a file into a background tab must not yank the
  // caret out of the chat composer.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && active !== document.body && !el.contains(active)) return;
    el.focus({ preventScroll: true });
  }, [filePath, loading]);

  // `/` is the only entry point; Cmd/Ctrl+F stays with the browser's own Find.
  // The bar renders as a sibling of this container, so a `/` typed into the
  // search input never reaches here.
  const handleContentKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== '/') return;
    e.preventDefault();
    setBarOpen(true);
    // No-op on first open (the input isn't mounted yet — SearchBar focuses
    // itself); this handles `/` pressed while the bar is already open.
    barInputRef.current?.focus();
    barInputRef.current?.select();
  };

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
      <div
        className="file-viewer-content"
        ref={contentRef}
        tabIndex={0}
        onKeyDown={handleContentKeyDown}
      >
        {isMarkdown ? (
          <div className="file-viewer-markdown-wrap">
            <div
              className="file-viewer-markdown"
              ref={setPaneContainer}
              onClick={handleMarkdownClick}
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
          <pre className="file-viewer-code" ref={setPaneContainer}>
            <code>{content}</code>
          </pre>
        )}
      </div>
      {barOpen && (
        <SearchBar
          inputRef={barInputRef}
          query={searchQuery}
          current={matchCurrent}
          total={matchTotal}
          onChange={handleSearchChange}
          onNext={() => adapterRef.current?.next()}
          onPrev={() => adapterRef.current?.prev()}
          onClose={closeSearch}
        />
      )}
    </div>
  );
}
