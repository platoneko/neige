import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { CreateConvRequest } from './types';
import './App.css';

function App() {
  const { conversations, connected, create, rename, remove } = useConversations();
  const { config, update: updateConfig } = useConfig();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showQuickLauncher, setShowQuickLauncher] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const dockviewApiRef = useRef<DockviewApi | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Tracks the last conversation panel that was active, so features like the
  // file picker's search root keep working while a file/web panel is focused.
  const [lastConvTabId, setLastConvTabId] = useState<string | null>(null);

  const syncTabState = useCallback(() => {
    const api = dockviewApiRef.current;
    if (!api) return;
    setOpenTabIds(api.panels.map((p) => p.id));
    const activeId = api.activePanel?.id ?? null;
    setActiveTabId(activeId);
    if (activeId && !activeId.startsWith('file:') && !activeId.startsWith('web:')) {
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
      // Use provided title, or look up from current conversations
      const resolvedTitle = title ?? conv?.title ?? 'untitled';
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
        openTab(conv.id, conv.title, conv.mode);
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
    [create, openTab, config.recentCommands, updateConfig, toast],
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
      api.addPanel({
        id: panelId,
        title: fileName,
        component: 'fileViewer',
        params: { filePath, baseCwd },
      });
      // Save to recent files (preserve baseCwd so re-opens still get a relative path)
      const recent = config.recentFiles || [];
      const filtered = recent.filter((r) => r.path !== filePath);
      const entry: RecentFile = { path: filePath, name: fileName };
      if (baseCwd) entry.baseCwd = baseCwd;
      updateConfig({ recentFiles: [entry, ...filtered].slice(0, 20) });
    },
    [config.recentFiles, updateConfig],
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

  // Sync conversation titles → dockview tab titles
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const conv = conversations.find((c) => c.id === panel.id);
      if (conv && panel.title !== conv.title) {
        panel.setTitle(conv.title);
      }
    }
  }, [conversations]);

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        connected={connected}
        openTabs={openTabIds}
        activeTab={activeTabId}
        onSelect={openTab}
        onRename={rename}
        onDelete={(id) => {
          const conv = conversations.find((c) => c.id === id);
          setDeleteTarget({ id, title: conv?.title ?? 'untitled' });
        }}
        onNew={() => setShowCreate(true)}
        portForwards={config.portForwards || []}
        onPortForwardUpdate={(ports) => {
          updateConfig({ portForwards: ports });
        }}
        tasks={config.tasks || []}
        onTasksUpdate={(tasks) => {
          updateConfig({ tasks });
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
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        config={config}
        onConfigUpdate={updateConfig}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Session"
        message={`Permanently delete "${deleteTarget?.title}"? This will remove the session and its metadata.`}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default App;
