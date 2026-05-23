import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Box, Dialog, Flex, Text, TextField } from '@radix-ui/themes';
import { searchFiles, type FileSearchEntry } from '../api';
import type { RecentFile } from '../hooks/useConfig';

type FileEntry = FileSearchEntry;

interface DisplayItem {
  name: string;
  path: string;
  isRecent: boolean;
  fullPath: string;
  baseCwd?: string;
}

interface FilePickerProps {
  open: boolean;
  onClose: () => void;
  onOpenFile: (path: string, name: string, baseCwd?: string) => void;
  searchRoot: string;
  recentFiles: RecentFile[];
}

export function FilePicker({ open, onClose, onOpenFile, searchRoot, recentFiles }: FilePickerProps) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSearchResults([]);
      setSelected(0);
    }
  }, [open, searchRoot]);

  const fetchFiles = useCallback(
    async (q: string) => {
      if (!searchRoot) return;
      setLoading(true);
      try {
        const data = await searchFiles(searchRoot, q || undefined);
        setSearchResults(data);
        setSelected(0);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [searchRoot],
  );

  const handleChange = (value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    if (value.trim()) {
      timerRef.current = setTimeout(() => fetchFiles(value), 150);
    } else {
      setSearchResults([]);
      setSelected(0);
    }
  };

  const buildDisplayList = (): DisplayItem[] => {
    const items: DisplayItem[] = [];
    const lq = query.toLowerCase();
    const seenPaths = new Set<string>();

    const filteredRecent = recentFiles.filter(
      (f) => !lq || f.name.toLowerCase().includes(lq) || f.path.toLowerCase().includes(lq),
    );
    const isUnderRoot = (p: string) =>
      !!searchRoot && (p === searchRoot || p.startsWith(searchRoot + '/'));
    filteredRecent.sort((a, b) => Number(isUnderRoot(b.path)) - Number(isUnderRoot(a.path)));
    for (const f of filteredRecent) {
      seenPaths.add(f.path);
      // Fall back to current searchRoot for legacy recents that lack a saved baseCwd.
      const baseCwd = f.baseCwd || (isUnderRoot(f.path) ? searchRoot : undefined);
      items.push({ name: f.name, path: f.path, isRecent: true, fullPath: f.path, baseCwd });
    }

    for (const f of searchResults) {
      const fullPath = `${searchRoot}/${f.path}`;
      if (seenPaths.has(fullPath)) continue;
      items.push({ name: f.name, path: f.path, isRecent: false, fullPath, baseCwd: searchRoot });
    }

    return items;
  };

  const displayList = buildDisplayList();

  const handleSelect = (item: DisplayItem) => {
    onOpenFile(item.fullPath, item.name, item.baseCwd);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((prev) => Math.min(prev + 1, displayList.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && displayList.length > 0) {
      e.preventDefault();
      handleSelect(displayList[selected]);
    }
  };

  useEffect(() => {
    const el = document.querySelector('[data-fp-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const extIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['md', 'markdown'].includes(ext)) return '📝';
    if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) return '🟨';
    if (['rs'].includes(ext)) return '🧡';
    if (['py'].includes(ext)) return '🐍';
    if (['json', 'toml', 'yaml', 'yml'].includes(ext)) return '⚙';
    if (['css', 'html'].includes(ext)) return '🎨';
    return '📄';
  };

  const hasRecent = displayList.some((d) => d.isRecent);
  const hasSearch = displayList.some((d) => !d.isRecent);
  let globalIdx = 0;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Content
        maxWidth="560px"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div onKeyDown={handleKeyDown}>
          <Dialog.Title>Open File</Dialog.Title>
          <Dialog.Description size="1" color="gray" mb="3">
            Recent files and fuzzy search inside the active session's cwd.
          </Dialog.Description>

          <TextField.Root
            ref={inputRef}
            size="3"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Search files by name…"
          >
            <TextField.Slot>🔍</TextField.Slot>
            {loading && <TextField.Slot side="right"><Spinner /></TextField.Slot>}
          </TextField.Root>

          <Box mt="3" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {displayList.length === 0 && !loading && (
              <Box py="5" style={{ textAlign: 'center' }}>
                <Text size="2" color="gray">
                  {query ? 'No files found' : 'No recent files. Type to search…'}
                </Text>
              </Box>
            )}

            {hasRecent && <SectionLabel>Recent files</SectionLabel>}
            {displayList
              .filter((d) => d.isRecent)
              .map((item) => {
                const idx = globalIdx++;
                return (
                  <Row
                    key={`recent:${item.fullPath}`}
                    selected={idx === selected}
                    icon={extIcon(item.name)}
                    title={item.name}
                    detail={item.path.replace(/^\/home\/[^/]+/, '~')}
                    badge="recent"
                    onClick={() => handleSelect(item)}
                    onHover={() => setSelected(idx)}
                  />
                );
              })}

            {hasRecent && hasSearch && <SectionLabel>Files</SectionLabel>}
            {displayList
              .filter((d) => !d.isRecent)
              .map((item) => {
                const idx = globalIdx++;
                return (
                  <Row
                    key={`search:${item.path}`}
                    selected={idx === selected}
                    icon={extIcon(item.name)}
                    title={item.name}
                    detail={item.path}
                    onClick={() => handleSelect(item)}
                    onHover={() => setSelected(idx)}
                  />
                );
              })}
          </Box>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      as="div"
      size="1"
      weight="medium"
      color="gray"
      mt="2"
      mb="1"
      style={{ paddingLeft: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}
    >
      {children}
    </Text>
  );
}

function Row({
  selected,
  icon,
  title,
  detail,
  badge,
  onClick,
  onHover,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  badge?: string;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <Flex
      data-fp-selected={selected}
      onClick={onClick}
      onMouseEnter={onHover}
      align="center"
      gap="3"
      px="3"
      py="2"
      style={{
        cursor: 'pointer',
        background: selected ? 'var(--accent-a3)' : 'transparent',
        borderRadius: 'var(--radius-3)',
      }}
    >
      <Box style={{ flex: '0 0 auto', width: 20, textAlign: 'center' }}>{icon}</Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap="2">
          <Text size="2" weight="medium" truncate>{title}</Text>
          {badge && <Badge size="1" color="gray" variant="soft">{badge}</Badge>}
        </Flex>
        <Text as="div" size="1" color="gray" truncate style={{ fontFamily: 'var(--code-font-family)' }}>
          {detail}
        </Text>
      </Box>
    </Flex>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid var(--gray-a4)',
        borderTopColor: 'var(--accent-9)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}
