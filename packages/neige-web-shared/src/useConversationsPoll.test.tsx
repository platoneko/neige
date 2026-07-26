/**
 * Covers `loadedOnce` — the flag a consumer must gate on before it destroys
 * state for sessions missing from the list. Its whole value is *when* it
 * flips, so these mount the hook in a probe component; a render-to-string
 * test, the style used elsewhere in this package, never runs effects and so
 * cannot observe it at all.
 *
 * Every case here was verified to fail against the matching break in the
 * hook (`useState(true)`, dropping the assignment, resetting it in a catch,
 * setting it only in `poll`). See task-8-report.md for that evidence.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ listConversations: vi.fn() }));

import { listConversations } from './api';
import { useConversationsPoll, type UseConversationsPollApi } from './useConversationsPoll';

// React only treats act() as a real flush boundary when this is set; without
// it every act call warns and effects can settle outside the assertions.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.mocked(listConversations);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Latest hook output, refreshed on every render of the probe.
let api: UseConversationsPollApi;
let root: Root | null = null;

function Probe({ intervalMs }: { intervalMs: number }) {
  api = useConversationsPoll({ intervalMs });
  return null;
}

async function mount(intervalMs: number) {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(<Probe intervalMs={intervalMs} />);
  });
}

afterEach(async () => {
  // Unmount aborts the poll loop, so a later test's timers can't observe it.
  await act(async () => {
    root?.unmount();
  });
  root = null;
  fetchMock.mockReset();
});

describe('useConversationsPoll loadedOnce', () => {
  it('is false while the first fetch is still pending', async () => {
    fetchMock.mockReturnValue(deferred<never[]>().promise);

    await mount(1000);

    expect(api.loadedOnce).toBe(false);
    // The empty list here means "not fetched yet", which is exactly what
    // loadedOnce exists to distinguish from "the server has none".
    expect(api.conversations).toEqual([]);
  });

  it('becomes true once the first fetch resolves', async () => {
    const first = deferred<never[]>();
    fetchMock.mockReturnValue(first.promise);

    await mount(1000);
    expect(api.loadedOnce).toBe(false);

    await act(async () => {
      first.resolve([]);
    });

    expect(api.loadedOnce).toBe(true);
  });

  it('stays true after a later fetch fails, on both the poll and refresh paths', async () => {
    fetchMock.mockResolvedValueOnce([]);
    await mount(1);
    expect(api.loadedOnce).toBe(true);

    fetchMock.mockRejectedValue(new Error('server down'));
    await act(async () => {
      await sleep(40);
    });

    // connected flipping proves a poll really failed in that window — without
    // it this case could pass by never polling again at all.
    expect(api.connected).toBe(false);
    expect(api.loadedOnce).toBe(true);

    await act(async () => {
      await api.refresh();
    });

    expect(api.loadedOnce).toBe(true);
  });

  it('is set by refresh, not only by the interval poll', async () => {
    // Poll's own request never settles, so only refresh can set the flag.
    fetchMock.mockReturnValue(deferred<never[]>().promise);
    await mount(1000);
    expect(api.loadedOnce).toBe(false);

    fetchMock.mockResolvedValueOnce([]);
    await act(async () => {
      await api.refresh();
    });

    expect(api.loadedOnce).toBe(true);
  });
});
