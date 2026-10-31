import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskTree } from './TaskTree';
import type { OpenFile } from '../tasks';
import type { ConvInfo } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root: ConvInfo = {
  id: 'r',
  title: 'neige',
  parent_id: null,
  status: 'running',
  program: 'claude',
  cwd: '/repo',
  effective_cwd: '/repo',
  created_at: '2024-01-01T00:00:00Z',
  use_worktree: false,
  worktree_branch: null,
  mode: 'terminal',
};

function file(filePath: string): OpenFile {
  return {
    panelId: `file:${filePath}`,
    filePath,
    fileName: filePath.slice(filePath.lastIndexOf('/') + 1),
    ownerId: 'r',
  };
}

let reactRoot: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => reactRoot?.unmount());
  host?.remove();
  reactRoot = null;
  host = null;
});

function renderFiles(paths: string[]): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  reactRoot = createRoot(host);
  const noop = () => {};
  act(() => {
    reactRoot!.render(
      <TaskTree
        tasks={[{ root, children: [] }]}
        openTabs={[]}
        activeTab={null}
        openFiles={paths.map(file)}
        onSelect={noop}
        onSelectFile={noop}
        onCloseFile={noop}
        onDelete={noop}
        onRename={noop}
        onNewAgent={noop}
        focusedIds={[]}
        onToggleFocus={noop}
      />,
    );
  });
  return host;
}

function rowTexts(el: HTMLElement): [string, string | null][] {
  return [...el.querySelectorAll('.file-row')].map((row) => [
    row.querySelector('.conv-title')!.textContent!,
    row.querySelector('.file-row-hint')?.textContent ?? null,
  ]);
}

describe('TaskTree file rows', () => {
  it('trails same-named files with the dir that tells them apart', () => {
    const el = renderFiles(['/repo/README.md', '/repo/web/README.md', '/repo/web/App.tsx']);

    expect(rowTexts(el)).toEqual([
      ['README.md', 'repo'],
      ['README.md', 'web'],
      ['App.tsx', null],
    ]);
  });
});
