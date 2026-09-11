import { useCallback, useRef } from 'react';
import {
  DockviewReact,
  type IDockviewPanelProps,
  type DockviewReadyEvent,
  type DockviewApi,
} from 'dockview';
import 'dockview-core/dist/styles/dockview.css';
import { useTerminal } from '../hooks/useTerminal';
import { listConversations, loadLayout, saveLayout } from '../api';
import { sanitizeLayout, type SerializedLayout } from '../layoutSanitize';
import { FileViewer } from './FileViewer';
import { WebView } from './WebView';
import { ChatPanel } from './ChatPanel';

interface TerminalPanelProps {
  dockviewApiRef: React.MutableRefObject<DockviewApi | null>;
  onTabClose?: (id: string) => void;
  onTabStateChange?: () => void;
}

/** The component dockview renders inside each panel */
function TerminalComponent({ params }: IDockviewPanelProps<{ convId: string }>) {
  useTerminal(params.convId);

  return (
    <div className="terminal-view">
      <div id={`terminal-${params.convId}`} className="terminal-container" />
    </div>
  );
}

/** File viewer panel for markdown/code files */
function FileViewerComponent({ params }: IDockviewPanelProps<{ filePath: string; baseCwd?: string }>) {
  return <FileViewer filePath={params.filePath} baseCwd={params.baseCwd} />;
}

/** Web view panel for browsing URLs */
function WebViewComponent({ params }: IDockviewPanelProps<{ url: string }>) {
  return <WebView url={params.url} />;
}

/** Chat-mode (Mode B) panel — Claude Code in headless stream-json mode */
function ChatPanelWrapper({ params }: IDockviewPanelProps<{ convId: string }>) {
  return <ChatPanel sessionId={params.convId} />;
}

/** Holds a right-side group open when no files are docked, so the layout
 *  stays in the user's default agent-left / files-right split instead of
 *  the agent panel snapping back to full width. Removed automatically the
 *  moment a real file panel joins the group. */
function PlaceholderComponent() {
  return (
    <div className="placeholder-panel">
      <span>Open a file with Ctrl+P</span>
    </div>
  );
}

const components = {
  terminal: TerminalComponent,
  fileViewer: FileViewerComponent,
  webView: WebViewComponent,
  chat: ChatPanelWrapper,
  placeholder: PlaceholderComponent,
};

export function TerminalPanel({ dockviewApiRef, onTabClose, onTabStateChange }: TerminalPanelProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const saveLayoutDebounced = useCallback((api: DockviewApi) => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const json = api.toJSON();
        saveLayout(json);
      } catch { /* ignore */ }
    }, 500);
  }, []);

  const handleReady = useCallback(
    async (e: DockviewReadyEvent) => {
      dockviewApiRef.current = e.api;

      // Restore layout from server, filtering out dead panels
      try {
        const [rawLayout, convs] = await Promise.all([
          loadLayout(),
          listConversations(),
        ]);
        if (rawLayout && typeof rawLayout === 'object') {
          const layout = sanitizeLayout(
            rawLayout as SerializedLayout,
            new Set(convs.map((c) => c.id)),
          );
          // Only restore if there are still valid panels
          const hasPanels = Object.keys(layout.panels ?? {}).length > 0;
          if (hasPanels) {
            try {
              // Dockview's fromJSON is typed tightly; we only use the shape
              // it emitted originally, so cast through unknown here.
              e.api.fromJSON(layout as unknown as Parameters<typeof e.api.fromJSON>[0]);
            } catch {
              // layout corrupt after filtering, start fresh
            }
          }
        }
      } catch {
        // ignore
      }

      // Auto-save layout on changes
      e.api.onDidLayoutChange(() => saveLayoutDebounced(e.api));

      // Sync tab state to parent on panel/active changes
      e.api.onDidAddPanel(() => onTabStateChange?.());
      e.api.onDidRemovePanel((panel) => {
        onTabClose?.(panel.id);
        onTabStateChange?.();
      });
      e.api.onDidActivePanelChange(() => onTabStateChange?.());

      // Initial sync after layout restore
      onTabStateChange?.();
    },
    [dockviewApiRef, onTabClose, onTabStateChange, saveLayoutDebounced],
  );

  return (
    <div className="terminal-panel">
      <DockviewReact
        components={components}
        onReady={handleReady}
        className="dockview-theme-abyss-spaced"
        defaultRenderer="always"
      />
    </div>
  );
}
