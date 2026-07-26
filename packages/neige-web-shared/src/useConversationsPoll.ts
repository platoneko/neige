import { useCallback, useEffect, useState } from 'react';
import { listConversations } from './api';
import type { ConvInfo } from './types';

export interface UseConversationsPollOptions {
  /** Base polling interval, in milliseconds. Defaults to 5000. */
  intervalMs?: number;
}

export interface UseConversationsPollApi {
  conversations: ConvInfo[];
  connected: boolean;
  /**
   * True once any fetch has resolved, never false again. `conversations` is
   * `[]` both before the first fetch and when the server genuinely has none,
   * and `connected` starts `true`, so this is the only way to tell the two
   * apart. A consumer that destroys state for sessions it can't find in the
   * list must gate on it.
   */
  loadedOnce: boolean;
  refresh: () => Promise<void>;
}

/**
 * Polls /api/conversations on a timer. Applies exponential backoff (1.5x) on
 * consecutive failures up to 30s, and exposes a `connected` flag that drives
 * the "offline" badge in either frontend.
 */
export function useConversationsPoll(
  opts: UseConversationsPollOptions = {},
): UseConversationsPollApi {
  const intervalMs = opts.intervalMs ?? 5000;
  const [conversations, setConversations] = useState<ConvInfo[]>([]);
  const [connected, setConnected] = useState(true);
  // Set by whichever fetch resolves first — `refresh` can beat the interval
  // poll, since callers fire it right after a create/rename/delete.
  const [loadedOnce, setLoadedOnce] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
      setConnected(true);
      setLoadedOnce(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failCount = 0;
    const MAX_INTERVAL = 30000;

    const poll = async () => {
      try {
        const list = await listConversations(controller.signal);
        if (controller.signal.aborted) return;
        setConversations(list);
        setConnected(true);
        setLoadedOnce(true);
        failCount = 0;
      } catch {
        if (controller.signal.aborted) return;
        setConnected(false);
        failCount++;
      }
      if (!controller.signal.aborted) {
        const delay =
          failCount > 0
            ? Math.min(intervalMs * Math.pow(1.5, failCount), MAX_INTERVAL)
            : intervalMs;
        timer = setTimeout(poll, delay);
      }
    };

    poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return { conversations, connected, loadedOnce, refresh };
}
