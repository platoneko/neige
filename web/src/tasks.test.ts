import { describe, expect, it } from 'vitest';
import { groupIntoTasks, staleOverrides, tabTitle } from './tasks';
import type { ConvInfo } from './types';

function conv(id: string, title: string, parent_id: string | null = null): ConvInfo {
  return {
    id,
    title,
    parent_id,
    status: 'running',
    program: 'claude',
    cwd: '/repo',
    effective_cwd: '/repo',
    created_at: '2024-01-01T00:00:00Z',
    use_worktree: false,
    worktree_branch: null,
    mode: 'terminal',
  };
}

describe('groupIntoTasks', () => {
  it('nests children under their root', () => {
    const groups = groupIntoTasks([
      conv('r', 'my-repo'),
      conv('a', 'refactor', 'r'),
      conv('b', 'tests', 'r'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.id).toBe('r');
    expect(groups[0].children.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('keeps unrelated roots separate', () => {
    const groups = groupIntoTasks([conv('r1', 'one'), conv('r2', 'two')]);
    expect(groups.map((g) => g.root.id)).toEqual(['r1', 'r2']);
    expect(groups.every((g) => g.children.length === 0)).toBe(true);
  });

  it('degrades an orphan into a task of its own', () => {
    // Parent gone (deleted by another client mid-poll) must not make the
    // child vanish from the sidebar.
    const groups = groupIntoTasks([conv('a', 'orphan', 'missing')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.id).toBe('a');
    expect(groups[0].children).toEqual([]);
  });

  it('preserves incoming root order', () => {
    // Ids deliberately run against lexicographic order so an implementation
    // that sorts instead of preserving arrival order cannot pass.
    const groups = groupIntoTasks([
      conv('r2', 'two'),
      conv('a', 'child', 'r1'),
      conv('r1', 'one'),
    ]);
    expect(groups.map((g) => g.root.id)).toEqual(['r2', 'r1']);
    expect(groups[1].children.map((c) => c.id)).toEqual(['a']);
  });

  it('keeps a grandchild visible as a task of its own', () => {
    // Depth-2 nesting is illegal, but a conversation the server sent must
    // never become unreachable in the UI — unopenable and undeletable.
    const groups = groupIntoTasks([
      conv('r', 'my-repo'),
      conv('mid', 'refactor', 'r'),
      conv('deep', 'sub-agent', 'mid'),
    ]);
    expect(groups.map((g) => g.root.id)).toEqual(['r', 'deep']);
    expect(groups[0].children.map((c) => c.id)).toEqual(['mid']);
    expect(groups[1].children).toEqual([]);
  });

  it('keeps a self-referencing conversation visible', () => {
    const groups = groupIntoTasks([conv('s', 'self', 's')]);
    expect(groups.map((g) => g.root.id)).toEqual(['s']);
    expect(groups[0].children).toEqual([]);
  });

  it('keeps a parent cycle visible', () => {
    const groups = groupIntoTasks([conv('a', 'one', 'b'), conv('b', 'two', 'a')]);
    expect(groups.map((g) => g.root.id)).toEqual(['a', 'b']);
    expect(groups.every((g) => g.children.length === 0)).toBe(true);
  });

  it('returns nothing for an empty list', () => {
    expect(groupIntoTasks([])).toEqual([]);
  });
});

describe('tabTitle', () => {
  const all = [conv('r', 'my-repo'), conv('a', 'refactor', 'r')];

  it('leaves a root title bare', () => {
    expect(tabTitle(all[0], all)).toBe('my-repo');
  });

  it('prefixes a child with its task name', () => {
    expect(tabTitle(all[1], all)).toBe('my-repo: refactor');
  });

  it('falls back to the bare title when the root is missing', () => {
    const orphan = conv('a', 'refactor', 'gone');
    expect(tabTitle(orphan, [orphan])).toBe('refactor');
  });

  it('leaves a grandchild bare so tab and sidebar agree', () => {
    // groupIntoTasks gives this one its own task row; prefixing the tab with
    // its non-root parent would contradict that.
    const nested = [
      conv('r', 'my-repo'),
      conv('mid', 'refactor', 'r'),
      conv('deep', 'sub-agent', 'mid'),
    ];
    expect(tabTitle(nested[2], nested)).toBe('sub-agent');
  });
});

describe('staleOverrides', () => {
  it('reports rows whose automatic value flipped', () => {
    const prev = new Map([['a', false], ['b', true]]);
    const next = new Map([['a', true], ['b', true]]);
    expect(staleOverrides(prev, next)).toEqual(['a']);
  });

  it('ignores rows that are new this render', () => {
    // A row with no previous value never had a manual override to discard.
    const prev = new Map<string, boolean>();
    const next = new Map([['a', true]]);
    expect(staleOverrides(prev, next)).toEqual([]);
  });

  it('ignores rows that stopped rendering', () => {
    // A row absent this render has no visible override left to discard.
    const prev = new Map([['a', true]]);
    const next = new Map<string, boolean>();
    expect(staleOverrides(prev, next)).toEqual([]);
  });

  it('reports nothing when values are unchanged', () => {
    const prev = new Map([['a', true]]);
    const next = new Map([['a', true]]);
    expect(staleOverrides(prev, next)).toEqual([]);
  });
});
