import { useCallback, useEffect, useRef, useState } from 'react';
import { getConfig, saveConfig } from '../api';

import type { PortForward } from '../components/PortForwardPanel';

export interface RecentCommand {
  program: string;
  cwd: string;
  title: string;
  use_worktree: boolean;
}

export interface RecentFile {
  path: string;
  name: string;
  // Conversation cwd captured when this file was opened, used to derive a
  // relative path in FileViewer. Optional for back-compat with old entries.
  baseCwd?: string;
}

export interface NeigeConfig {
  proxy?: string;
  defaultProgram?: string;
  portForwards?: PortForward[];
  recentCommands?: RecentCommand[];
  recentFiles?: RecentFile[];
}

export function useConfig() {
  const [config, setConfig] = useState<NeigeConfig>({});
  const configRef = useRef(config);
  configRef.current = config;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((data) => {
        if (cancelled) return;
        setConfig(data as NeigeConfig);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<NeigeConfig>) => {
    const next = { ...configRef.current, ...patch };
    setConfig(next);
    await saveConfig(next as Record<string, unknown>);
  }, []);

  return { config, update, loaded };
}
