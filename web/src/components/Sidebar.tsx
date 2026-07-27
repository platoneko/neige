import { useCallback, useRef, useState } from 'react';
import { Folder, MessageSquare, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '@neige/shared';
import type { ConvInfo } from '../types';
import type { OpenFile, TaskGroup } from '../tasks';
import { PortForwardPanel } from './PortForwardPanel';
import type { PortForward } from './PortForwardPanel';
import { TaskTree } from './TaskTree';
import { useBusyTerminalIds } from '../hooks/terminalBusy';

export type { PortForward };

interface SidebarProps {
  className?: string;
  conversations: ConvInfo[];
  /** Same conversations, grouped into tasks for the expanded tree. The flat
   *  list is still needed for the collapsed rail, which has no hierarchy. */
  tasks: TaskGroup[];
  onNewAgent: (root: ConvInfo) => void;
  connected: boolean;
  openTabs: string[];
  activeTab: string | null;
  openFiles: OpenFile[];
  onSelectFile: (panelId: string) => void;
  onCloseFile: (panelId: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  portForwards: PortForward[];
  onPortForwardUpdate: (ports: PortForward[]) => void;
}

const COLLAPSED_WIDTH = 48;
const MIN_EXPANDED_WIDTH = 200;
const SNAP_THRESHOLD = 120;
const DEFAULT_WIDTH = 280;
const MAX_WIDTH = 480;

export function Sidebar({
  className = '',
  conversations,
  tasks,
  onNewAgent,
  connected,
  openTabs,
  activeTab,
  openFiles,
  onSelectFile,
  onCloseFile,
  onSelect,
  onDelete,
  onRename,
  onNew,
  portForwards,
  onPortForwardUpdate,
}: SidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const dragging = useRef(false);
  const widthBeforeCollapse = useRef(DEFAULT_WIDTH);
  const busyIds = useBusyTerminalIds();

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      if (prev) {
        setSidebarWidth(widthBeforeCollapse.current);
        return false;
      } else {
        widthBeforeCollapse.current = sidebarWidth;
        setSidebarWidth(COLLAPSED_WIDTH);
        return true;
      }
    });
  }, [sidebarWidth]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = collapsed ? COLLAPSED_WIDTH : sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const raw = startWidth + ev.clientX - startX;

      if (raw < SNAP_THRESHOLD) {
        setSidebarWidth(COLLAPSED_WIDTH);
        setCollapsed(true);
      } else {
        const clamped = Math.min(MAX_WIDTH, Math.max(MIN_EXPANDED_WIDTH, raw));
        setSidebarWidth(clamped);
        setCollapsed(false);
        widthBeforeCollapse.current = clamped;
      }
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth, collapsed]);

  return (
    <aside
      className={`sidebar ${className} ${collapsed ? 'sidebar-collapsed' : ''}`}
      style={{ width: sidebarWidth, minWidth: COLLAPSED_WIDTH }}
    >
      <div
        className={`sidebar-resize-handle ${dragging.current ? 'dragging' : ''}`}
        onMouseDown={onResizeStart}
      />

      {collapsed ? (
        <>
          <div className="sidebar-collapsed-header">
            <button
              className="sidebar-collapse-btn"
              onClick={toggleCollapse}
              title="Expand sidebar"
              aria-label="Toggle sidebar"
            >
              &#9776;
            </button>
            <span
              className={`server-status ${connected ? 'connected' : 'disconnected'}`}
              title={connected ? 'Server connected' : 'Server disconnected'}
            />
          </div>
          <div className="sidebar-collapsed-actions">
            <button
              className="sidebar-collapsed-btn"
              onClick={onNew}
              title="New task"
              aria-label="New task"
            >
              +
            </button>
          </div>
          <div className="conv-list-collapsed">
            {conversations.map((c) => {
              const isTask = c.parent_id === null;
              return (
                <button
                  key={c.id}
                  className={`conv-dot-btn ${activeTab === c.id ? 'active' : ''} ${busyIds.has(c.id) ? 'busy' : ''}`}
                  onClick={() => onSelect(c.id)}
                  title={c.title}
                  aria-label={c.title}
                >
                  <span
                    className={`conv-kind-icon ${isTask ? 'task' : `agent ${c.mode}`}`}
                    aria-hidden
                  >
                    {isTask ? (
                      <Folder size={14} strokeWidth={2} />
                    ) : c.mode === 'chat' ? (
                      <MessageSquare size={13} strokeWidth={2} />
                    ) : (
                      <TerminalIcon size={13} strokeWidth={2} />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-header">
            <div className="sidebar-title-row">
              <h1>neige</h1>
              <span
                className={`server-status ${connected ? 'connected' : 'disconnected'}`}
                title={connected ? 'Server connected' : 'Server disconnected'}
              />
            </div>
            <div className="sidebar-header-actions">
              <Button variant="primary" size="sm" className="btn-new" onClick={onNew}>
                <span className="btn-new-icon">+</span> New Task
              </Button>
              <button
                className="sidebar-collapse-btn"
                onClick={toggleCollapse}
                title="Collapse sidebar"
                aria-label="Toggle sidebar"
              >
                &#9664;
              </button>
            </div>
          </div>
          {tasks.length === 0 ? (
            <div className="conv-list">
              <div className="empty-list">
                <svg className="empty-list-icon" viewBox="0 0 48 48" fill="none" width="48" height="48">
                  <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M16 22h16M16 28h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
                  <circle cx="12" cy="22" r="1.5" fill="currentColor" opacity="0.3" />
                  <circle cx="12" cy="28" r="1.5" fill="currentColor" opacity="0.3" />
                </svg>
                <p>No tasks yet</p>
                <button className="btn-empty-new" onClick={onNew}>
                  Create your first task
                </button>
              </div>
            </div>
          ) : (
            <TaskTree
              tasks={tasks}
              openTabs={openTabs}
              activeTab={activeTab}
              openFiles={openFiles}
              onSelectFile={onSelectFile}
              onCloseFile={onCloseFile}
              busyIds={busyIds}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              onNewAgent={onNewAgent}
            />
          )}
          <PortForwardPanel
            ports={portForwards}
            onUpdate={onPortForwardUpdate}
          />
        </>
      )}
    </aside>
  );
}
