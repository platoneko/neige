import { describe, expect, it } from 'vitest';
import { panelIdsClosedByDelete, sanitizeLayout } from './layoutSanitize';

describe('sanitizeLayout', () => {
  it('drops conversation panels whose sessions are gone', () => {
    const layout = {
      panels: {
        alive: { id: 'alive', title: 'ok' },
        dead: { id: 'dead', title: 'gone' },
      },
      grid: {
        root: {
          type: 'leaf',
          data: { views: ['alive', 'dead'], activeView: 'dead', id: 'g1' },
        },
      },
    };

    const next = sanitizeLayout(layout, new Set(['alive']));

    expect(Object.keys(next.panels ?? {})).toEqual(['alive']);
    expect((next.grid?.root as { data: { views: string[] } }).data.views).toEqual([
      'alive',
    ]);
    expect(
      (next.grid?.root as { data: { activeView: string } }).data.activeView,
    ).toBe('alive');
  });

  it('keeps file and web panels when filtering dead sessions', () => {
    // The old filter keyed only on conversation ids, so every reload stripped
    // every file tab and left their ids dangling in grid.views — fromJSON then
    // threw on undefined panel data.
    const layout = {
      panels: {
        a: { id: 'a', title: 'agent' },
        'file:/repo/x.md': {
          id: 'file:/repo/x.md',
          title: 'x.md',
          params: { ownerId: 'a' },
        },
        'web:https://example.com': {
          id: 'web:https://example.com',
          title: 'example.com',
        },
      },
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: { views: ['a'], activeView: 'a', id: 'agents' },
            },
            {
              type: 'leaf',
              data: {
                views: ['file:/repo/x.md', 'web:https://example.com'],
                activeView: 'file:/repo/x.md',
                id: 'files',
              },
            },
          ],
        },
      },
    };

    const next = sanitizeLayout(layout, new Set(['a']));

    expect(Object.keys(next.panels ?? {}).sort()).toEqual([
      'a',
      'file:/repo/x.md',
      'web:https://example.com',
    ]);
  });

  it('drops file panels whose owning agent is gone', () => {
    const layout = {
      panels: {
        a: { id: 'a', title: 'agent' },
        'file:/repo/orphan.md': {
          id: 'file:/repo/orphan.md',
          title: 'orphan.md',
          params: { ownerId: 'deleted' },
        },
      },
      grid: {
        root: {
          type: 'leaf',
          data: {
            views: ['a', 'file:/repo/orphan.md'],
            activeView: 'a',
            id: 'g1',
          },
        },
      },
    };

    const next = sanitizeLayout(layout, new Set(['a']));

    expect(next.panels).toEqual({ a: layout.panels.a });
    expect((next.grid?.root as { data: { views: string[] } }).data.views).toEqual([
      'a',
    ]);
  });
});

describe('panelIdsClosedByDelete', () => {
  it('closes only the agent when deleting a child', () => {
    const ids = panelIdsClosedByDelete(
      'child',
      [
        { id: 'root', parent_id: null },
        { id: 'child', parent_id: 'root' },
        { id: 'sibling', parent_id: 'root' },
      ],
      [{ panelId: 'file:/a.md', ownerId: 'child' }],
    );
    expect([...ids].sort()).toEqual(['child', 'file:/a.md']);
  });

  it('closes every child and their files when deleting a task root', () => {
    // handleDeleteConfirm used to remove only the clicked panel; children
    // waited on a post-refresh effect and could linger in the tab bar after
    // vanishing from the sidebar.
    const ids = panelIdsClosedByDelete(
      'root',
      [
        { id: 'root', parent_id: null },
        { id: 'a', parent_id: 'root' },
        { id: 'b', parent_id: 'root' },
      ],
      [
        { panelId: 'file:/a.md', ownerId: 'a' },
        { panelId: 'file:/root.md', ownerId: 'root' },
        { panelId: 'file:/other.md', ownerId: 'unrelated' },
      ],
    );
    expect([...ids].sort()).toEqual([
      'a',
      'b',
      'file:/a.md',
      'file:/root.md',
      'root',
    ]);
  });
});
