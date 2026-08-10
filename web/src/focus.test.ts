import { describe, expect, it } from 'vitest';
import { isFocused, pruneFocus, toggleFocus } from './focus';

describe('toggleFocus', () => {
  it('adds an id to an empty list', () => {
    expect(toggleFocus([], 'a')).toEqual(['a']);
  });

  it('removes an existing id', () => {
    expect(toggleFocus(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('does not duplicate an already-focused id', () => {
    expect(toggleFocus(['a'], 'a')).toEqual([]);
  });
});

describe('isFocused', () => {
  it('returns true when present', () => {
    expect(isFocused(['a', 'b'], 'b')).toBe(true);
  });

  it('returns false when absent', () => {
    expect(isFocused(['a'], 'b')).toBe(false);
  });
});

describe('pruneFocus', () => {
  it('drops ids not in the live set', () => {
    expect(pruneFocus(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['a', 'c']);
  });

  it('returns the same reference when nothing changed', () => {
    const ids = ['a', 'b'];
    expect(pruneFocus(ids, new Set(['a', 'b', 'c']))).toBe(ids);
  });

  it('returns empty when live set is empty', () => {
    expect(pruneFocus(['a', 'b'], new Set())).toEqual([]);
  });
});
