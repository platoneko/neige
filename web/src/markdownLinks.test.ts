import { describe, it, expect } from 'vitest';
import {
  classifyMarkdownHref,
  stripHrefToPath,
  dirnamePath,
  basenamePath,
  joinNormalize,
  resolveMarkdownPath,
} from './markdownLinks';

describe('classifyMarkdownHref', () => {
  it('classifies external schemes', () => {
    expect(classifyMarkdownHref('https://example.com')).toBe('external');
    expect(classifyMarkdownHref('http://example.com')).toBe('external');
    expect(classifyMarkdownHref('//cdn.example.com/x')).toBe('external');
    expect(classifyMarkdownHref('mailto:a@b.c')).toBe('external');
  });

  it('classifies hash-only', () => {
    expect(classifyMarkdownHref('#heading')).toBe('hash');
    expect(classifyMarkdownHref('#')).toBe('hash');
  });

  it('classifies paths', () => {
    expect(classifyMarkdownHref('./a.md')).toBe('path');
    expect(classifyMarkdownHref('../wiki/b.md')).toBe('path');
    expect(classifyMarkdownHref('/home/x/y.md')).toBe('path');
    expect(classifyMarkdownHref('docs/x.md#sec')).toBe('path');
  });

  it('ignores empty and dangerous schemes', () => {
    expect(classifyMarkdownHref('')).toBe('ignore');
    expect(classifyMarkdownHref(null)).toBe('ignore');
    expect(classifyMarkdownHref(undefined)).toBe('ignore');
    expect(classifyMarkdownHref('javascript:alert(1)')).toBe('ignore');
    expect(classifyMarkdownHref('data:text/html,hi')).toBe('ignore');
  });
});

describe('stripHrefToPath', () => {
  it('strips hash and query', () => {
    expect(stripHrefToPath('c.md#sec')).toBe('c.md');
    expect(stripHrefToPath('c.md?x=1')).toBe('c.md');
    expect(stripHrefToPath('c.md?x=1#sec')).toBe('c.md');
    expect(stripHrefToPath('#only')).toBe('');
  });
});

describe('path utils', () => {
  it('dirnamePath / basenamePath', () => {
    expect(dirnamePath('/proj/docs/index.md')).toBe('/proj/docs');
    expect(basenamePath('/proj/docs/index.md')).toBe('index.md');
    expect(dirnamePath('/index.md')).toBe('/');
    expect(basenamePath('alone.md')).toBe('alone.md');
  });

  it('joinNormalize collapses dots', () => {
    expect(joinNormalize('/proj/docs', './a.md')).toBe('/proj/docs/a.md');
    expect(joinNormalize('/proj/docs', '../wiki/b.md')).toBe('/proj/wiki/b.md');
    expect(joinNormalize('/a/b', '../../c.md')).toBe('/c.md');
    expect(joinNormalize('/a/b', '/abs/x.md')).toBe('/abs/x.md');
  });
});

describe('resolveMarkdownPath', () => {
  const cur = '/proj/docs/index.md';

  it('resolves relative and absolute', () => {
    expect(resolveMarkdownPath(cur, './a.md')).toBe('/proj/docs/a.md');
    expect(resolveMarkdownPath(cur, '../wiki/b.md')).toBe('/proj/wiki/b.md');
    expect(resolveMarkdownPath(cur, '/home/x/y.md')).toBe('/home/x/y.md');
  });

  it('normalizes absolute with dots', () => {
    expect(resolveMarkdownPath(cur, '/a/b/../c.md')).toBe('/a/c.md');
  });

  it('returns null for empty after strip', () => {
    expect(resolveMarkdownPath(cur, '')).toBe(null);
    expect(resolveMarkdownPath(cur, '#heading')).toBe(null);
  });
});
