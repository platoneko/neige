/**
 * Pure helpers for the user's "focus" set — agents they are watching.
 * Persistence lives in NeigeConfig.focusedAgentIds; this module only
 * mutates arrays immutably.
 */

export function isFocused(ids: readonly string[], agentId: string): boolean {
  return ids.includes(agentId);
}

/** Add agentId if absent, remove if present. Never duplicates. */
export function toggleFocus(ids: readonly string[], agentId: string): string[] {
  if (ids.includes(agentId)) {
    return ids.filter((id) => id !== agentId);
  }
  return [...ids, agentId];
}

/**
 * Drop ids that are not in the live conversation set.
 * Returns the same array reference when nothing changed so callers can
 * skip a config write.
 */
export function pruneFocus(
  ids: readonly string[],
  liveIds: ReadonlySet<string>,
): string[] {
  const next = ids.filter((id) => liveIds.has(id));
  if (next.length === ids.length && next.every((id, i) => id === ids[i])) {
    return ids as string[];
  }
  return next;
}
