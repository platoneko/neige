/* eslint-disable react-refresh/only-export-components -- co-locate the pure
   extractHeadings + tocHeadingId utilities with the component that uses them */
import * as Tooltip from '@radix-ui/react-tooltip';

export type TocLevel = 1 | 2 | 3 | 4;

export interface TocHeading {
  level: TocLevel;
  text: string;
  id: string;
}

const HEADING_RE = /^ {0,3}(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})/;
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;
const ID_PREFIX = 'md-h-';
const TOC_MAX_LEN = 20;

export function tocHeadingId(index: number): string {
  return `${ID_PREFIX}${index}`;
}

export function truncateTocText(text: string): string {
  if (text.length <= TOC_MAX_LEN) return text;
  return text.slice(0, TOC_MAX_LEN - 3) + '...';
}

export function stripInlineMarkdown(input: string): string {
  let out = input;
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1');
  out = out.replace(/(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, '$1');
  return out.trim();
}

export function extractHeadings(text: string): TocHeading[] {
  if (!text) return [];
  const out: TocHeading[] = [];
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  // Non-blank, non-heading line immediately preceding the current one; a `===`
  // or `---` underline below such a line is a CommonMark setext heading.
  let setextCandidate: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceChar === null) {
      if (fenceMatch) {
        fenceChar = fenceMatch[2][0] as '`' | '~';
        fenceLen = fenceMatch[2].length;
        setextCandidate = null;
        continue;
      }
    } else {
      if (
        fenceMatch &&
        fenceMatch[2][0] === fenceChar &&
        fenceMatch[2].length >= fenceLen
      ) {
        fenceChar = null;
        fenceLen = 0;
      }
      setextCandidate = null;
      continue;
    }
    if (line.trim().length === 0) {
      // Blank line breaks any setext continuation — `---` after a blank is a
      // thematic break, not a setext underline.
      setextCandidate = null;
      continue;
    }
    if (setextCandidate !== null) {
      const setextMatch = line.match(SETEXT_RE);
      if (setextMatch) {
        const level: TocLevel = setextMatch[1][0] === '=' ? 1 : 2;
        const stripped = stripInlineMarkdown(setextCandidate.trim());
        if (stripped) {
          out.push({ level, text: stripped, id: tocHeadingId(out.length) });
        }
        setextCandidate = null;
        continue;
      }
    }
    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1].length as TocLevel;
      const stripped = stripInlineMarkdown(m[2]);
      if (stripped) {
        out.push({ level, text: stripped, id: tocHeadingId(out.length) });
      }
      setextCandidate = null;
      continue;
    }
    setextCandidate = line;
  }
  return out;
}

export interface MarkdownTocProps {
  headings: TocHeading[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (heading: TocHeading) => void;
}

export function MarkdownToc({
  headings,
  activeId,
  collapsed,
  onToggleCollapsed,
  onSelect,
}: MarkdownTocProps) {
  const toggleLabel = collapsed ? 'Expand outline' : 'Collapse outline';
  return (
    <aside
      className={`file-viewer-md-toc${collapsed ? ' collapsed' : ''}`}
      aria-label="Outline"
    >
      <div className="file-viewer-md-toc-head">
        {!collapsed && (
          <span className="file-viewer-md-toc-title">Outline</span>
        )}
        <button
          type="button"
          className="file-viewer-md-toc-toggle"
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">{collapsed ? '‹' : '›'}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="file-viewer-md-toc-list">
          {headings.length === 0 ? (
            <div className="file-viewer-md-toc-empty">No headings</div>
          ) : (
            <Tooltip.Provider delayDuration={150} skipDelayDuration={80}>
              {headings.map((h) => {
                const shown = truncateTocText(h.text);
                const truncated = shown !== h.text;
                const btn = (
                  <button
                    key={h.id}
                    type="button"
                    data-level={h.level}
                    className={`file-viewer-md-toc-entry${
                      activeId === h.id ? ' active' : ''
                    }`}
                    onClick={() => onSelect(h)}
                  >
                    {shown}
                  </button>
                );
                if (!truncated) return btn;
                return (
                  <Tooltip.Root key={h.id}>
                    <Tooltip.Trigger asChild>{btn}</Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="left"
                        align="center"
                        sideOffset={6}
                        collisionPadding={8}
                        className="file-viewer-md-toc-tip"
                      >
                        {h.text}
                        <Tooltip.Arrow className="file-viewer-md-toc-tip-arrow" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                );
              })}
            </Tooltip.Provider>
          )}
        </div>
      )}
    </aside>
  );
}
