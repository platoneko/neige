import { createContext, useContext, type ReactNode } from 'react';

export type OpenFileFn = (
  filePath: string,
  fileName: string,
  baseCwd?: string,
) => void;

const OpenFileContext = createContext<OpenFileFn | null>(null);

export function OpenFileProvider({
  openFile,
  children,
}: {
  openFile: OpenFileFn;
  children: ReactNode;
}) {
  return (
    <OpenFileContext.Provider value={openFile}>
      {children}
    </OpenFileContext.Provider>
  );
}

/** null when not under provider — callers must no-op path opens safely. */
export function useOpenFile(): OpenFileFn | null {
  return useContext(OpenFileContext);
}
