import type { ConvInfo } from './types';

/**
 * A task and the agents under it. A task has no identity of its own — it
 * IS its root agent: the task name is `root.title` and the task directory
 * is `root.cwd`.
 */
export interface TaskGroup {
  root: ConvInfo;
  children: ConvInfo[];
}

/**
 * A file panel open in dockview, moored to the agent it was opened from.
 * `ownerId` is absent only when no conversation existed to open it under.
 */
export interface OpenFile {
  panelId: string;
  filePath: string;
  fileName: string;
  ownerId?: string;
}

/**
 * Dir hints for open files whose names collide in the sidebar, keyed by
 * panelId. Each colliding file gets the shortest trailing run of its dir
 * that no same-named file shares; a file with a unique name gets none.
 */
export function fileDirHints(files: OpenFile[]): Map<string, string> {
  const byName = new Map<string, OpenFile[]>();
  for (const f of files) {
    const group = byName.get(f.fileName);
    if (group) group.push(f);
    else byName.set(f.fileName, [f]);
  }

  const hints = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const dirs = group.map((f) => f.filePath.split('/').filter(Boolean).slice(0, -1));
    for (const [i, f] of group.entries()) {
      const hint = uniqueDirSuffix(dirs, i);
      if (hint !== undefined) hints.set(f.panelId, hint);
    }
  }
  return hints;
}

function uniqueDirSuffix(dirs: string[][], i: number): string | undefined {
  const maxDepth = Math.max(...dirs.map((d) => d.length)) + 1;
  for (let k = 1; k <= maxDepth; k++) {
    const mine = dirSuffix(dirs[i], k);
    if (dirs.every((d, j) => j === i || dirSuffix(d, k) !== mine)) return mine;
  }
  // Only reachable when two same-named files share a dir, i.e. the same path.
  return undefined;
}

// Past the dir's own depth the suffix is the whole dir, written absolute so
// it can't equal another file's relative tail ('/x' vs 'y/x').
function dirSuffix(dir: string[], k: number): string {
  return k > dir.length ? `/${dir.join('/')}` : dir.slice(-k).join('/');
}

/**
 * Group a flat conversation list into tasks, preserving the incoming order
 * of roots. Every conversation reaches the output: one whose parent is not
 * itself a root — an orphan left by another client's delete, illegal
 * depth-2 nesting, a self-reference or a cycle — degrades to a task of its
 * own rather than disappearing into an unreachable row.
 */
export function groupIntoTasks(conversations: ConvInfo[]): TaskGroup[] {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  // A conversation heads a task unless its parent is present and is itself a
  // root — keeps orphans and any illegal depth-2 nesting visible.
  const isRoot = (c: ConvInfo) => {
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    return !parent || parent.parent_id !== null;
  };

  const groups = new Map<string, TaskGroup>();
  for (const c of conversations) {
    if (isRoot(c)) groups.set(c.id, { root: c, children: [] });
  }
  for (const c of conversations) {
    if (isRoot(c)) continue;
    // isRoot already proved the parent exists and heads a group, so the
    // optional chain is belt-and-braces rather than a live branch.
    groups.get(c.parent_id!)?.children.push(c);
  }
  return [...groups.values()];
}

/**
 * Dockview tab title. Root agents keep their bare title; child agents get
 * the task name prefixed so a tab is readable away from the sidebar.
 */
export function tabTitle(conv: ConvInfo, conversations: ConvInfo[]): string {
  if (!conv.parent_id) return conv.title;
  const parent = conversations.find((c) => c.id === conv.parent_id);
  // Prefix only under a real task. Anything groupIntoTasks would promote to
  // its own task stays bare, so a tab never claims a parent the sidebar
  // does not show it under.
  if (!parent || parent.parent_id !== null) return conv.title;
  return `${parent.title}: ${conv.title}`;
}

/**
 * Rows whose automatic expand value flipped since the previous render.
 * Those hand control back to the automatic rule, discarding any manual
 * toggle. Rows appearing for the first time are excluded — they have no
 * override to discard.
 */
export function staleOverrides(
  prev: Map<string, boolean>,
  next: Map<string, boolean>,
): string[] {
  const stale: string[] = [];
  for (const [id, value] of next) {
    if (prev.has(id) && prev.get(id) !== value) stale.push(id);
  }
  return stale;
}
