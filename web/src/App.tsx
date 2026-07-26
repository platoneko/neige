import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DockviewApi } from 'dockview';
import { Dialog, DialogContent, useToast } from '@neige/shared';
import { Sidebar } from './components/Sidebar';
import { TerminalPanel } from './components/TerminalPanel';
import { CreateDialog } from './components/CreateDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FilePicker } from './components/FilePicker';
import { QuickLauncher } from './components/QuickLauncher';
import { useConversations } from './hooks/useConversations';
import { useConfig, type RecentFile } from './hooks/useConfig';
import { groupIntoTasks, tabTitle, type OpenFile } from './tasks';
import type { ConvInfo, CreateConvRequest } from './types';
import './App.css';

/**
 * Panel ids are namespaced by prefix; a conversation panel is the unprefixed
 * case. Single source of truth because the cleanup effect below *removes*
 * panels on this answer — a new prefix taught to only one caller would make
 * that effect silently eat the new panel type.
 */
const isConvPanel = (panelId: string) =>
  !panelId.startsWith('file:') && !panelId.startsWith('web:');

function App() {
  const { conversations, connected, loadedOnce, create, rename, remove } = useConversations();
  const taskGroups = useMemo(() => groupIntoTasks(conversations), [conversations]);
  const { config, update: updateConfig } = useConfig();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  // Set when the create dialog was opened from a task row's + button; the
  // dialog then locks cwd to this task's directory. Null = new task.
  const [createParent, setCreateParent] = useState<ConvInfo | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showQuickLauncher, setShowQuickLauncher] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
    /** Child agents that will be removed along with this one. */
    agentCount: number;
  } | null>(null);
  const dockviewApiRef = useRef<DockviewApi | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Tracks the last conversation panel that was active, so features like the
  // file picker's search root keep working while a file/web panel is focused.
  const [lastConvTabId, setLastConvTabId] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);

  const syncTabState = useCallback(() => {
    const api = dockviewApiRef.current;
    if (!api) return;
    setOpenTabIds(api.panels.map((p) => p.id));
    setOpenFiles(
      api.panels
        .filter((p) => p.id.startsWith('file:'))
        .map((p) => {
          const params = p.params as
            | { filePath?: string; ownerId?: string }
            | undefined;
          return {
            panelId: p.id,
            filePath: params?.filePath ?? '',
            fileName: p.title ?? '',
            ownerId: params?.ownerId,
          };
        }),
    );
    const activeId = api.activePanel?.id ?? null;
    setActiveTabId(activeId);
    if (activeId && isConvPanel(activeId)) {
      setLastConvTabId(activeId);
    }
  }, []);

  const openTab = useCallback(
    (id: string, title?: string, modeOverride?: 'terminal' | 'chat') => {
      const api = dockviewApiRef.current;
      if (!api) return;

      // If panel already exists, focus it
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }

      const conv = conversations.find((c) => c.id === id);
      // A caller-supplied title is taken verbatim and bypasses tabTitle, so
      // passing a bare conv.title here would silently drop the task prefix.
      const resolvedTitle = title ?? (conv ? tabTitle(conv, conversations) : 'untitled');
      // Chat-mode sessions render a ChatView; everything else uses xterm.
      // Caller can pass modeOverride to avoid stale-state lookup right after
      // create() resolves (the conversations array may not have re-rendered yet).
      const mode = modeOverride ?? conv?.mode ?? 'terminal';
      const component = mode === 'chat' ? 'chat' : 'terminal';

      api.addPanel({
        id,
        title: resolvedTitle,
        component,
        params: { convId: id },
      });
    },
    [conversations],
  );

  const handleCreate = useCallback(
    async (req: CreateConvRequest) => {
      try {
        const conv = await create(req);
        // openTab's own lookup can't see a session created moments ago, so
        // title and mode must be passed explicitly or the tab falls back to
        // 'untitled'/'terminal'. Splicing conv into the array is belt-and-braces
        // only: tabTitle uses that array solely to resolve the parent, which is
        // already in `conversations`.
        openTab(conv.id, tabTitle(conv, [...conversations, conv]), conv.mode);
        // Save to recent commands
        const recent = config.recentCommands || [];
        const entry = { program: req.program, cwd: req.cwd, title: req.title, use_worktree: req.use_worktree };
        // Deduplicate by program+cwd
        const filtered = recent.filter(
          (r) => !(r.program === entry.program && r.cwd === entry.cwd),
        );
        updateConfig({ recentCommands: [entry, ...filtered].slice(0, 10) });
      } catch (err) {
        toast({
          variant: 'error',
          title: 'Failed to create conversation',
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [create, openTab, conversations, config.recentCommands, updateConfig, toast],
  );

  const openFile = useCallback(
    (filePath: string, fileName: string, baseCwd?: string) => {
      const api = dockviewApiRef.current;
      if (!api) return;
      // Use file path as panel ID (prefix to avoid collision with conv IDs)
      const panelId = `file:${filePath}`;
      const existing = api.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        return;
      }
      // Moor the panel to the agent it was opened from so the sidebar can
      // nest it there. lastConvTabId already follows the active conversation,
      // so this lands on the same agent as the file picker's search root —
      // including its self-healing lookup: resolving through `conversations`
      // means a deleted id misses and falls through, where trusting the id
      // directly would stamp an owner the cleanup effect then kills on sight.
      const ownerId =
        conversations.find((c) => c.id === lastConvTabId)?.id ?? conversations[0]?.id;
      api.addPanel({
        id: panelId,
        title: fileName,
        component: 'fileViewer',
        params: { filePath, baseCwd, ownerId },
      });
      // Save to recent files (preserve baseCwd so re-opens still get a relative path)
      const recent = config.recentFiles || [];
      const filtered = recent.filter((r) => r.path !== filePath);
      const entry: RecentFile = { path: filePath, name: fileName };
      if (baseCwd) entry.baseCwd = baseCwd;
      updateConfig({ recentFiles: [entry, ...filtered].slice(0, 20) });
    },
    [config.recentFiles, updateConfig, lastConvTabId, conversations],
  );

  const openUrl = useCallback(
    (url: string) => {
      const api = dockviewApiRef.current;
      if (!api) return;
      const panelId = `web:${url}`;
      const existing = api.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        return;
      }
      // Extract domain for tab title
      let title = url;
      try {
        title = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      } catch { /* use full url */ }
      api.addPanel({
        id: panelId,
        title,
        component: 'webView',
        params: { url },
      });
    },
    [],
  );

  const focusPanel = useCallback((panelId: string) => {
    dockviewApiRef.current?.getPanel(panelId)?.api.setActive();
  }, []);

  const closePanel = useCallback((panelId: string) => {
    const api = dockviewApiRef.current;
    const panel = api?.getPanel(panelId);
    if (api && panel) api.removePanel(panel);
  }, []);

  // Ctrl+P to open file picker, Ctrl+N to open quick launcher, Ctrl+L to open URL input,
  // Ctrl+W to close the active file panel (skips terminals so shell delete-word still works;
  // Mac's Cmd+W is reserved by the browser, hence Ctrl only)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setShowFilePicker((prev) => !prev);
        setShowQuickLauncher(false);
        setShowUrlInput(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        setShowQuickLauncher((prev) => !prev);
        setShowFilePicker(false);
        setShowUrlInput(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        setShowUrlInput((prev) => !prev);
        setShowFilePicker(false);
        setShowQuickLauncher(false);
      }
      if (e.ctrlKey && !e.metaKey && e.key === 'w') {
        const api = dockviewApiRef.current;
        const active = api?.activePanel;
        if (active && active.id.startsWith('file:')) {
          e.preventDefault();
          api!.removePanel(active);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Tab X in dockview = detach only (panel already removed by dockview)
  const handleTabClose = useCallback((_id: string) => {
    // Panel is already removed by dockview; syncTabState updates sidebar
  }, []);

  // Sidebar delete = real delete with confirmation
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const { id, title } = deleteTarget;
    const api = dockviewApiRef.current;
    if (api) {
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
    }
    try {
      await remove(id);
    } catch (err) {
      toast({
        variant: 'error',
        title: `Failed to delete "${title}"`,
        description: err instanceof Error ? err.message : String(err),
      });
    }
    setDeleteTarget(null);
  }, [deleteTarget, remove, toast]);

  // Sync conversation titles → dockview tab titles. Renaming a task also
  // reflows its children's tabs, since their prefix is the task name.
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const conv = conversations.find((c) => c.id === panel.id);
      if (!conv) continue;
      const next = tabTitle(conv, conversations);
      if (panel.title !== next) panel.setTitle(next);
    }
  }, [conversations]);

  // Panels don't outlive their session. A conversation panel whose session
  // is gone, and a file panel whose owning agent is gone, both lose their
  // place in the tree. `handleDeleteConfirm` only removes the one panel the
  // user clicked, so this is what closes a task's child agents when the
  // delete cascades — and what handles sessions removed by another client.
  // Two gates, two jobs. `loadedOnce` is what stops a list that hasn't
  // arrived from reading as "every session is gone": layout restore issues
  // its own fetch and can finish first, and panels removed here are then
  // persisted by the debounced layout writer — the user's tabs would be gone
  // for good, not just this launch. `connected` defers teardown across a
  // network blip: a failed request never writes `conversations` (the hook
  // sets it only on success), so the list freezes at its last good value
  // and keeps aging while the server is unreachable. Tearing panels down
  // against that snapshot would act on evidence older than the outage, so
  // wait for a fresh confirmation — the panels cost nothing to keep.
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api || !loadedOnce || !connected) return;
    const alive = new Set(conversations.map((c) => c.id));
    for (const panel of api.panels) {
      if (!isConvPanel(panel.id)) continue;
      if (!alive.has(panel.id)) api.removePanel(panel);
    }
    for (const f of openFiles) {
      if (f.ownerId && !alive.has(f.ownerId)) {
        const panel = api.getPanel(f.panelId);
        if (panel) api.removePanel(panel);
      }
    }
  }, [conversations, openFiles, loadedOnce, connected]);

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        tasks={taskGroups}
        onNewAgent={(root) => {
          setCreateParent(root);
          setShowCreate(true);
        }}
        connected={connected}
        openTabs={openTabIds}
        activeTab={activeTabId}
        openFiles={openFiles}
        onSelectFile={focusPanel}
        onCloseFile={closePanel}
        onSelect={openTab}
        onRename={rename}
        onDelete={(id) => {
          const conv = conversations.find((c) => c.id === id);
          // Only a task root heads a group, so a child agent's delete lands
          // here with no group and a count of 0 — it takes nothing with it.
          const group = taskGroups.find((g) => g.root.id === id);
          setDeleteTarget({
            id,
            title: conv?.title ?? 'untitled',
            agentCount: group?.children.length ?? 0,
          });
        }}
        onNew={() => {
          setCreateParent(null);
          setShowCreate(true);
        }}
        portForwards={config.portForwards || []}
        onPortForwardUpdate={(ports) => {
          updateConfig({ portForwards: ports });
        }}
      />
      <main className="main">
        <TerminalPanel
          dockviewApiRef={dockviewApiRef}
          onTabClose={handleTabClose}
          onTabStateChange={syncTabState}
        />
      </main>
      <QuickLauncher
        open={showQuickLauncher}
        onClose={() => setShowQuickLauncher(false)}
        onLaunch={(cmd) => {
          handleCreate({
            title: cmd.title || '',
            program: cmd.program,
            cwd: cmd.cwd,
            use_worktree: cmd.use_worktree,
          });
        }}
        onSelect={openTab}
        recentCommands={config.recentCommands || []}
        conversations={conversations}
      />
      <Dialog open={showUrlInput} onOpenChange={setShowUrlInput}>
        <DialogContent className="max-w-xl p-0">
          <div className="url-input-dialog">
            <input
              className="url-input-field"
              autoFocus
              placeholder="Enter URL (e.g. bilibili.com)"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) {
                    let dest = val;
                    if (!dest.startsWith('http://') && !dest.startsWith('https://')) {
                      dest = 'https://' + dest;
                    }
                    openUrl(dest);
                    setShowUrlInput(false);
                  }
                }
                // Escape handled by Radix Dialog via onOpenChange
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <FilePicker
        open={showFilePicker}
        onClose={() => setShowFilePicker(false)}
        onOpenFile={openFile}
        searchRoot={
          conversations.find((c) => c.id === activeTabId)?.effective_cwd
          || conversations.find((c) => c.id === lastConvTabId)?.effective_cwd
          || conversations[0]?.effective_cwd
          || ''
        }
        recentFiles={config.recentFiles || []}
      />
      <CreateDialog
        open={showCreate}
        // `createParent` deliberately survives the close. Radix keeps the
        // content mounted through its exit animation, so clearing here would
        // visibly re-render the dialog as top-level on the way out — the
        // title flips and the worktree card pops back in. Both open paths
        // set `createParent` unconditionally, so nothing stale can leak in.
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        config={config}
        onConfigUpdate={updateConfig}
        parent={
          createParent
            ? { id: createParent.id, title: createParent.title, cwd: createParent.cwd }
            : undefined
        }
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget && deleteTarget.agentCount > 0 ? 'Delete Task' : 'Delete Session'}
        message={
          deleteTarget && deleteTarget.agentCount > 0
            ? `Permanently delete task "${deleteTarget.title}" and its ${deleteTarget.agentCount} agent${deleteTarget.agentCount === 1 ? '' : 's'}? This will remove all sessions and their metadata.`
            : `Permanently delete "${deleteTarget?.title}"? This will remove the session and its metadata.`
        }
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default App;
