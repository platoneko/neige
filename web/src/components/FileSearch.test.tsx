import { describe, it, expect, beforeEach } from 'vitest';
import { collectMatches, createSearchAdapter } from './FileSearch';

function pane(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

// Stand-in for the browser's Highlight object: records the ranges it was
// given so the tests can assert what the adapter registered.
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  add(range: Range) {
    this.ranges.push(range);
  }
}

type Registry = Map<string, FakeHighlight>;

function installHighlightApi(): Registry {
  const store: Registry = new Map();
  Object.defineProperty(globalThis, 'Highlight', {
    value: FakeHighlight,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'CSS', {
    value: {
      highlights: {
        set: (name: string, value: FakeHighlight) => store.set(name, value),
        delete: (name: string) => store.delete(name),
      },
    },
    configurable: true,
    writable: true,
  });
  return store;
}

function uninstallHighlightApi() {
  Object.defineProperty(globalThis, 'CSS', {
    value: {},
    configurable: true,
    writable: true,
  });
}

describe('collectMatches', () => {
  it('returns nothing for an empty needle', () => {
    expect(collectMatches(pane('<p>alpha beta</p>'), '')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const ranges = collectMatches(pane('<p>Alpha ALPHA alpha</p>'), 'alpha');
    expect(ranges).toHaveLength(3);
    expect(ranges.map((r) => r.toString())).toEqual(['Alpha', 'ALPHA', 'alpha']);
  });

  it('finds repeated, non-overlapping matches inside one text node', () => {
    const ranges = collectMatches(pane('<p>aaaa</p>'), 'aa');
    expect(ranges).toHaveLength(2);
    expect(ranges.map((r) => r.startOffset)).toEqual([0, 2]);
  });

  it('walks across sibling and nested text nodes', () => {
    const ranges = collectMatches(
      pane('<p>hit one</p><div><span>hit two</span></div>'),
      'hit',
    );
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P');
    expect(ranges[1].startContainer.parentElement?.tagName).toBe('SPAN');
  });

  it('skips script and style text', () => {
    const ranges = collectMatches(
      pane('<script>hit</script><style>hit</style><p>hit</p>'),
      'hit',
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P');
  });
});

describe('createSearchAdapter', () => {
  let store: Registry;

  beforeEach(() => {
    store = installHighlightApi();
  });

  function build(html: string) {
    const counts: Array<[number, number]> = [];
    const adapter = createSearchAdapter(pane(html), null, (current, total) =>
      counts.push([current, total]),
    );
    return { adapter, counts };
  }

  it('reports the first match and highlights every match', () => {
    const { adapter, counts } = build('<p>a b a b a</p>');
    adapter.setQuery('a');
    expect(counts.at(-1)).toEqual([1, 3]);
    expect(store.get('fv-search-all')?.ranges).toHaveLength(3);
    expect(store.get('fv-search-current')?.ranges).toHaveLength(1);
  });

  it('wraps around in both directions', () => {
    const { adapter, counts } = build('<p>a a a</p>');
    adapter.setQuery('a');
    adapter.next();
    expect(counts.at(-1)).toEqual([2, 3]);
    adapter.next();
    adapter.next();
    expect(counts.at(-1)).toEqual([1, 3]);
    adapter.prev();
    expect(counts.at(-1)).toEqual([3, 3]);
  });

  it('does not move when there is nothing to move between', () => {
    const { adapter, counts } = build('<p>alpha</p>');
    adapter.setQuery('zzz');
    expect(counts.at(-1)).toEqual([0, 0]);
    adapter.next();
    adapter.prev();
    expect(counts).toHaveLength(1);
  });

  it('clears the highlights on an empty query', () => {
    const { adapter, counts } = build('<p>alpha</p>');
    adapter.setQuery('alpha');
    adapter.setQuery('');
    expect(counts.at(-1)).toEqual([0, 0]);
    expect(store.has('fv-search-all')).toBe(false);
    expect(store.has('fv-search-current')).toBe(false);
  });

  it('unregisters its highlights on dispose', () => {
    const { adapter } = build('<p>alpha</p>');
    adapter.setQuery('alpha');
    expect(store.size).toBe(2);
    adapter.dispose();
    expect(store.size).toBe(0);
  });

  it('degrades to a no-op when the Highlight API is missing', () => {
    uninstallHighlightApi();
    const { adapter, counts } = build('<p>alpha</p>');
    adapter.setQuery('alpha');
    expect(counts.at(-1)).toEqual([0, 0]);
    expect(store.size).toBe(0);
  });
});
