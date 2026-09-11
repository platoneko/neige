/**
 * Dockview persists layout as `{ grid, panels, activeGroup }`. Conversation
 * panels use bare session UUIDs; files/urls/placeholder use prefixed ids.
 */

export interface LayoutPanel {
  id: string;
  title?: string;
  params?: { ownerId?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface LayoutLeafData {
  views: string[];
  activeView?: string;
  id?: string;
  [key: string]: unknown;
}

export type LayoutNode =
  | { type: 'leaf'; data: LayoutLeafData; size?: number; [key: string]: unknown }
  | { type: 'branch'; data: LayoutNode[]; size?: number; [key: string]: unknown }
  | { type: string; data?: unknown; [key: string]: unknown };

export interface SerializedLayout {
  panels?: Record<string, LayoutPanel>;
  grid?: { root: LayoutNode; [key: string]: unknown };
  activeGroup?: string;
  [key: string]: unknown;
}

const isKeepAlivePanel = (id: string) =>
  id.startsWith('file:') || id.startsWith('web:') || id === 'placeholder:right';

function keepPanel(id: string, panel: LayoutPanel, validConvIds: Set<string>): boolean {
  if (isKeepAlivePanel(id)) {
    const ownerId = panel.params?.ownerId;
    // Unmoored file panels (no owner) survive; moored ones die with their agent.
    if (id.startsWith('file:') && ownerId) return validConvIds.has(ownerId);
    return true;
  }
  return validConvIds.has(id);
}

function cleanNode(node: LayoutNode, kept: Set<string>): boolean {
  if (node.type === 'leaf' && node.data && typeof node.data === 'object') {
    const data = node.data as LayoutLeafData;
    if (!Array.isArray(data.views)) return true;
    data.views = data.views.filter((id) => kept.has(id));
    if (data.activeView && !kept.has(data.activeView)) {
      data.activeView = data.views[data.views.length - 1];
    }
    return data.views.length > 0;
  }
  if (node.type === 'branch' && Array.isArray(node.data)) {
    node.data = (node.data as LayoutNode[]).filter((child) => cleanNode(child, kept));
    return (node.data as LayoutNode[]).length > 0;
  }
  return true;
}

/**
 * Strip panels (and their grid.views entries) that cannot be restored because
 * their session is gone. File/web/placeholder panels are kept unless a file's
 * owning agent is among the missing sessions.
 */
export function sanitizeLayout(
  layout: SerializedLayout,
  validConvIds: Set<string>,
): SerializedLayout {
  const panels = layout.panels ?? {};
  const nextPanels = Object.fromEntries(
    Object.entries(panels).filter(([id, panel]) => keepPanel(id, panel, validConvIds)),
  );
  const kept = new Set(Object.keys(nextPanels));
  const next: SerializedLayout = { ...layout, panels: nextPanels };
  if (next.grid?.root) {
    cleanNode(next.grid.root, kept);
  }
  return next;
}

/** Minimal conversation shape needed to resolve a task's children. */
export interface DeleteConvRef {
  id: string;
  parent_id: string | null;
}

export interface DeleteFileRef {
  panelId: string;
  ownerId?: string;
}

/**
 * Every dockview panel that must close when `deletedId` is removed — the
 * target itself, its child agents when it heads a task, and file panels
 * moored to any of those agents.
 */
export function panelIdsClosedByDelete(
  deletedId: string,
  conversations: DeleteConvRef[],
  openFiles: DeleteFileRef[],
): Set<string> {
  const ids = new Set<string>([deletedId]);
  for (const c of conversations) {
    if (c.parent_id === deletedId) ids.add(c.id);
  }
  for (const f of openFiles) {
    if (f.ownerId && ids.has(f.ownerId)) ids.add(f.panelId);
  }
  return ids;
}
