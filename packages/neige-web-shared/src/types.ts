/**
 * Bare discriminator string. Terminal = PTY/xterm.js; Chat = headless
 * stream-json. Use this for UI controls that just toggle between modes
 * without yet knowing the chat name (form state, segmented controls).
 * Once you have a full session record, prefer `SessionMode` instead so
 * the chat `name` is type-checked alongside the discriminator.
 */
export type SessionModeTag = 'terminal' | 'chat';

/**
 * Discriminated union mirroring the Rust `SessionMode { Terminal,
 * Chat { name } }` enum. The `name` field lives next to `mode` on the
 * wire — the server flattens it from the chat variant — and is the
 * server-globally-unique handle AI/MCP tools use to address the session
 * (in place of the UUID `id`).
 */
export type SessionMode =
  | { mode: 'terminal' }
  | { mode: 'chat'; name: string };

interface ConvInfoBase {
  id: string;
  /** Free-form display label (sidebar / tab). Not unique. */
  title: string;
  status: 'running' | 'detached' | 'dead';
  program: string;
  cwd: string;
  /** Actual working directory (worktree path if applicable) */
  effective_cwd: string;
  created_at: string;
  use_worktree: boolean;
  worktree_branch: string | null;
  /**
   * The task this agent belongs to. `null` = this agent IS a task; its
   * title is the task name and its cwd the task directory. Nesting is
   * exactly one level deep.
   */
  parent_id: string | null;
}

export type ConvInfo = ConvInfoBase & SessionMode;

interface CreateConvRequestBase {
  title: string;
  program: string;
  cwd: string;
  proxy?: string;
  use_worktree: boolean;
  worktree_name?: string;
  /** Create this agent inside an existing task. Omit for a new task. */
  parent_id?: string;
}

/**
 * `mode` is optional on terminal creates (server defaults to terminal when
 * absent); chat creates must pass `mode: 'chat'` and a sibling `name`.
 */
export type CreateConvRequest =
  | (CreateConvRequestBase & { mode?: 'terminal' })
  | (CreateConvRequestBase & { mode: 'chat'; name: string });

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export interface BrowseResponse {
  path: string;
  entries: DirEntry[];
  is_git_repo: boolean;
}

export interface NeigeConfig {
  proxy?: string;
  [key: string]: unknown;
}
