import { useCallback } from 'react';
import {
  createConversation,
  deleteConversation,
  renameConversation,
  resumeConversation,
  useConversationsPoll,
  type ConvInfo,
  type CreateConvRequest,
} from '@neige/shared';

/**
 * Desktop wrapper around the shared polling hook. Adds the CRUD callbacks
 * that App.tsx expects; each refreshes the list after it resolves so the
 * sidebar reflects the change immediately without waiting for the next poll.
 */
export function useConversations() {
  const { conversations, connected, loadedOnce, refresh } = useConversationsPoll({
    intervalMs: 3000,
  });

  const create = useCallback(
    async (req: CreateConvRequest): Promise<ConvInfo> => {
      const conv = await createConversation(req);
      await refresh();
      return conv;
    },
    [refresh],
  );

  const resume = useCallback(
    async (id: string): Promise<ConvInfo> => {
      const conv = await resumeConversation(id);
      await refresh();
      return conv;
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      await renameConversation(id, title);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      await refresh();
    },
    [refresh],
  );

  return { conversations, connected, loadedOnce, create, resume, rename, remove, refresh };
}
