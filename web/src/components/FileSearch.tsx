/* eslint-disable react-refresh/only-export-components -- co-locate the pure
   collectMatches + createSearchAdapter utilities with the bar that drives them */
import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/**
 * Drives "next / prev / total" over one file pane. Both panes the viewer can
 * show — rendered markdown and the `<pre>` source — are plain DOM, so one
 * range-based implementation covers both and no per-pane polymorphism is needed.
 */
export interface SearchAdapter {
  /** An empty pattern clears the highlights and reports a zero count. */
  setQuery(pattern: string): void;
  next(): void;
  prev(): void;
  dispose(): void;
}

// CSS Custom Highlight API guards. Stable in current Chrome/Safari/Firefox;
// where it is missing (older engines, some test environments) the adapter
// degrades to a no-op — the bar still opens and accepts input, it just does
// not paint anything.
interface HighlightLike {
  add(range: Range): void;
  /** Higher wins when two highlights cover the same range. */
  priority?: number;
}

interface HighlightCtor {
  new (...ranges: Range[]): HighlightLike;
}

interface HighlightsRegistry {
  set(name: string, value: HighlightLike): unknown;
  delete(name: string): boolean;
}

function highlightsRegistry(): HighlightsRegistry | null {
  if (typeof CSS === 'undefined') return null;
  return (CSS as unknown as { highlights?: HighlightsRegistry }).highlights ?? null;
}

function highlightCtor(): HighlightCtor | null {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null;
}

const HIGHLIGHT_ALL = 'fv-search-all';
const HIGHLIGHT_CURRENT = 'fv-search-current';

let hasWarnedNoHighlight = false;

/**
 * Walk `root`'s text nodes and return every case-insensitive occurrence of
 * `needle` as a DOM Range. Text inside <script>/<style> is skipped: it is not
 * visible, so a match there could never be scrolled to.
 */
export function collectMatches(root: Element, needle: string): Range[] {
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const ranges: Range[] = [];

  const collectFrom = (text: Text) => {
    const lowered = text.data.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = lowered.indexOf(lower, from);
      if (idx === -1) return;
      const range = document.createRange();
      range.setStart(text, idx);
      range.setEnd(text, idx + lower.length);
      ranges.push(range);
      from = idx + lower.length;
    }
  };

  // Hand-rolled rather than createTreeWalker: happy-dom's walker stops at the
  // first filtered-out element instead of descending through it, which would
  // make this untestable.
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) collectFrom(child as Text);
      else if (child.nodeName !== 'SCRIPT' && child.nodeName !== 'STYLE') walk(child);
    }
  };

  walk(root);
  return ranges;
}

/**
 * Bring `range` into view by adjusting the scroller directly.
 *
 * `element.scrollIntoView()` is not usable here: in the source pane the whole
 * file is a single text node, so a match's nearest element is the one `<code>`
 * wrapping everything and scrolling to it always lands at line 1.
 */
function scrollRangeIntoView(range: Range, scroller: HTMLElement | null) {
  if (!scroller) return;
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  // Park the match a third of the way down rather than at the very edge, so
  // the surrounding lines stay readable.
  scroller.scrollTop += rect.top - box.top - box.height / 3;
}

/**
 * Build a search adapter over the DOM subtree `container`, scrolling matches
 * into view inside `scroller`. `onCount` fires whenever the match count or the
 * current index changes so the bar can render `3/17`.
 */
export function createSearchAdapter(
  container: Element,
  scroller: HTMLElement | null,
  onCount: (current: number, total: number) => void,
): SearchAdapter {
  const registry = highlightsRegistry();
  const Highlight = highlightCtor();
  if (!registry || !Highlight) {
    if (!hasWarnedNoHighlight && import.meta.env.DEV) {
      hasWarnedNoHighlight = true;
      console.warn(
        '[file-viewer] CSS Custom Highlight API unavailable; in-file search will not highlight.',
      );
    }
    return {
      setQuery: () => onCount(0, 0),
      next: () => {},
      prev: () => {},
      dispose: () => {},
    };
  }

  let ranges: Range[] = [];
  let currentIndex = 0;

  const clear = () => {
    registry.delete(HIGHLIGHT_ALL);
    registry.delete(HIGHLIGHT_CURRENT);
  };

  const applyHighlights = () => {
    if (ranges.length === 0) {
      clear();
      onCount(0, 0);
      return;
    }
    // Feed the ranges in one at a time instead of `new Highlight(...ranges)`:
    // a one-letter query over a large file yields tens of thousands of matches
    // and spreading that many arguments overflows the call stack.
    const all = new Highlight();
    for (const r of ranges) all.add(r);
    registry.set(HIGHLIGHT_ALL, all);

    const current = ranges[currentIndex];
    // Prefer the current match when both highlights cover the same range;
    // equal priority leaves paint order to registration order, which can hide
    // the stronger "current" style under the all-matches wash.
    const currentHl = new Highlight(current);
    currentHl.priority = 1;
    registry.set(HIGHLIGHT_CURRENT, currentHl);
    scrollRangeIntoView(current, scroller);
    onCount(currentIndex + 1, ranges.length);
  };

  const step = (delta: number) => {
    if (ranges.length === 0) return;
    currentIndex = (currentIndex + delta + ranges.length) % ranges.length;
    applyHighlights();
  };

  return {
    setQuery(pattern) {
      ranges = collectMatches(container, pattern);
      currentIndex = 0;
      applyHighlights();
    },
    next: () => step(1),
    prev: () => step(-1),
    dispose() {
      ranges = [];
      currentIndex = 0;
      clear();
    },
  };
}

interface SearchBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  current: number;
  total: number;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export function SearchBar({
  inputRef,
  query,
  current,
  total,
  onChange,
  onNext,
  onPrev,
  onClose,
}: SearchBarProps) {
  useEffect(() => {
    inputRef.current?.focus();
    // Mount-focus only; re-focusing on every render would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  const countLabel = total > 0 ? `${current || 1}/${total}` : query ? 'no match' : '';

  return (
    <div className="fv-search-bar" role="search">
      <input
        ref={inputRef}
        type="search"
        aria-label="Search in file"
        placeholder="Search…"
        value={query}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onInputKey}
      />
      <span className="fv-search-count" aria-live="polite">
        {countLabel}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match"
        onClick={onPrev}
        disabled={total === 0}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match"
        onClick={onNext}
        disabled={total === 0}
      >
        ↓
      </button>
      <button type="button" aria-label="Close search" title="Close search" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
