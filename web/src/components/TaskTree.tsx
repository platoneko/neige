import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  Terminal as TerminalIcon,
} from 'lucide-react';
import type { ConvInfo } from '../types';
import { activityClass, rollUpActivity, type Activity } from '@neige/shared';
import { staleOverrides, type OpenFile, type TaskGroup } from '../tasks';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function InlineTitle({
  value,
  onSave,
}: {
  value: string;
  onSave: (newTitle: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editing, value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="conv-title-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className="conv-title"
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      title="Double-click to rename"
    >
      {value}
    </span>
  );
}

interface AgentRowProps {
  conv: ConvInfo;
  /** Task rows are root agents and carry the task-level affordances. */
  isTask: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  /**
   * What to indicate on this row. Usually the conv's own activity; a
   * collapsed task row passes its children's roll-up instead.
   */
  activity: Activity;
  active: boolean;
  open: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNewAgent?: () => void;
}

function AgentRow({
  conv,
  isTask,
  expandable,
  expanded,
  onToggle,
  activity,
  active,
  open,
  onSelect,
  onDelete,
  onRename,
  onNewAgent,
}: AgentRowProps) {
  return (
    <div
      className={`conv-item ${isTask ? 'task-row' : 'agent-row'} ${active ? 'active' : ''} ${open ? 'open' : ''} ${activityClass(activity)}`}
      onClick={() => onSelect(conv.id)}
    >
      <button
        className={`row-chevron ${expandable ? '' : 'row-chevron-hidden'}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        tabIndex={expandable ? 0 : -1}
        aria-hidden={!expandable}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse' : 'Expand'}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <span
        className={`conv-kind-icon ${isTask ? 'task' : `agent ${conv.mode}`}`}
        title={
          isTask
            ? 'Task'
            : conv.mode === 'chat'
              ? 'Chat agent (stream-json)'
              : 'Terminal agent (PTY)'
        }
        aria-label={isTask ? 'task' : conv.mode}
      >
        {isTask ? (
          expanded ? (
            <FolderOpen size={13} strokeWidth={2} />
          ) : (
            <Folder size={13} strokeWidth={2} />
          )
        ) : conv.mode === 'chat' ? (
          <MessageSquare size={12} strokeWidth={2} />
        ) : (
          <TerminalIcon size={12} strokeWidth={2} />
        )}
      </span>
      <div className="conv-info">
        <InlineTitle value={conv.title} onSave={(t) => onRename(conv.id, t)} />
        <span className="conv-meta">
          <span className="conv-path">{conv.cwd}</span>
          {conv.worktree_branch && (
            <span className="conv-branch" title={conv.worktree_branch}>
              &#9741; {conv.worktree_branch.replace('neige/', '')}
            </span>
          )}
          <span className="conv-time">{timeAgo(conv.created_at)}</span>
        </span>
      </div>
      <div className="conv-actions">
        {isTask && onNewAgent && (
          <button
            className="btn-new-agent"
            onClick={(e) => {
              e.stopPropagation();
              onNewAgent();
            }}
            title="New agent in this task"
            aria-label="New agent in this task"
          >
            +
          </button>
        )}
        <button
          className="btn-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(conv.id);
          }}
          title={isTask ? 'Delete task' : 'Delete agent'}
          aria-label={isTask ? 'Delete task' : 'Delete agent'}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function FileRow({
  file,
  nested,
  active,
  onSelect,
  onClose,
}: {
  file: OpenFile;
  /** True for a child agent's files, which indent one step deeper than a
   *  root agent's. Both kinds render the same `.file-row` and both trail a
   *  `.conv-item` sibling, so depth is a fact about the tree model, not
   *  about position — the only DOM trace of it is the wrapper div around
   *  each child, which exists to key the React list and would vanish the
   *  moment that markup is reshuffled. Carry it explicitly instead. */
  nested: boolean;
  active: boolean;
  onSelect: (panelId: string) => void;
  onClose: (panelId: string) => void;
}) {
  return (
    <div
      className={`conv-item file-row ${nested ? 'file-row-nested' : ''} ${active ? 'active' : ''}`}
      onClick={() => onSelect(file.panelId)}
      title={file.filePath}
    >
      <span className="file-row-icon">
        <FileText size={12} strokeWidth={2} />
      </span>
      <span className="conv-title">{file.fileName}</span>
      <div className="conv-actions">
        <button
          className="btn-delete"
          onClick={(e) => {
            e.stopPropagation();
            onClose(file.panelId);
          }}
          title="Close file"
          aria-label="Close file"
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface TaskTreeProps {
  tasks: TaskGroup[];
  openTabs: string[];
  activeTab: string | null;
  openFiles: OpenFile[];
  onSelect: (id: string) => void;
  onSelectFile: (panelId: string) => void;
  onCloseFile: (panelId: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNewAgent: (root: ConvInfo) => void;
}

export function TaskTree({
  tasks,
  openTabs,
  activeTab,
  openFiles,
  onSelect,
  onSelectFile,
  onCloseFile,
  onDelete,
  onRename,
  onNewAgent,
}: TaskTreeProps) {
  // Both levels follow one rule: a row expands while it has something to
  // reveal. For a task row that's its child agents plus the root's own
  // files — the root's window being open reveals nothing new, so it
  // deliberately doesn't count. For an agent row it's just its files.
  // A manual toggle overrides the rule until the automatic value flips.
  const filesOf = useMemo(() => {
    const map = new Map<string, OpenFile[]>();
    for (const f of openFiles) {
      if (!f.ownerId) continue;
      const list = map.get(f.ownerId);
      if (list) list.push(f);
      else map.set(f.ownerId, [f]);
    }
    return map;
  }, [openFiles]);

  const autoExpand = useMemo(() => {
    const hasContent = (c: ConvInfo) =>
      openTabs.includes(c.id) || (filesOf.get(c.id)?.length ?? 0) > 0;
    const map = new Map<string, boolean>();
    for (const t of tasks) {
      map.set(
        t.root.id,
        t.children.some(hasContent) || (filesOf.get(t.root.id)?.length ?? 0) > 0,
      );
      for (const c of t.children) {
        map.set(c.id, (filesOf.get(c.id)?.length ?? 0) > 0);
      }
    }
    return map;
  }, [tasks, openTabs, filesOf]);

  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const prevAuto = useRef(autoExpand);

  useEffect(() => {
    const stale = staleOverrides(prevAuto.current, autoExpand);
    prevAuto.current = autoExpand;
    if (stale.length === 0) return;
    setOverride((prev) => {
      const next = new Map(prev);
      for (const id of stale) next.delete(id);
      return next;
    });
  }, [autoExpand]);

  const isExpanded = (rowId: string) =>
    override.get(rowId) ?? autoExpand.get(rowId) ?? false;

  const toggle = (rowId: string) =>
    setOverride((prev) => new Map(prev).set(rowId, !isExpanded(rowId)));

  return (
    <div className="conv-list">
      {tasks.map((task) => {
        const rootFiles = filesOf.get(task.root.id) ?? [];
        const taskExpanded = isExpanded(task.root.id);
        return (
          <div key={task.root.id} className="task-group">
            <AgentRow
              conv={task.root}
              isTask
              expandable={task.children.length > 0 || rootFiles.length > 0}
              expanded={taskExpanded}
              onToggle={() => toggle(task.root.id)}
              activity={
                taskExpanded
                  ? task.root.activity
                  : rollUpActivity([task.root, ...task.children])
              }
              active={activeTab === task.root.id}
              open={openTabs.includes(task.root.id)}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              onNewAgent={() => onNewAgent(task.root)}
            />
            {taskExpanded && (
              <>
                {rootFiles.map((f) => (
                  <FileRow
                    key={f.panelId}
                    file={f}
                    nested={false}
                    active={activeTab === f.panelId}
                    onSelect={onSelectFile}
                    onClose={onCloseFile}
                  />
                ))}
                {task.children.map((child) => {
                  const childFiles = filesOf.get(child.id) ?? [];
                  const childExpanded = isExpanded(child.id);
                  return (
                    <div key={child.id}>
                      <AgentRow
                        conv={child}
                        isTask={false}
                        expandable={childFiles.length > 0}
                        expanded={childExpanded}
                        onToggle={() => toggle(child.id)}
                        activity={child.activity}
                        active={activeTab === child.id}
                        open={openTabs.includes(child.id)}
                        onSelect={onSelect}
                        onDelete={onDelete}
                        onRename={onRename}
                      />
                      {childExpanded &&
                        childFiles.map((f) => (
                          <FileRow
                            key={f.panelId}
                            file={f}
                            nested
                            active={activeTab === f.panelId}
                            onSelect={onSelectFile}
                            onClose={onCloseFile}
                          />
                        ))}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
