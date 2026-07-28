import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { useTerminalCore } from '@neige/shared'
import type { TerminalStatus } from '@neige/shared'
import { cardActivity } from './cardActivity'

export interface UseTerminalApi {
  sendText: (s: string) => void
  sendKey: (s: string) => void
  status: TerminalStatus
  termRef: RefObject<Terminal | null>
}

/**
 * Mobile-flavoured terminal hook. Thin wrapper over `useTerminalCore` that
 * layers on:
 *   - mobile theme + system-ui mono font
 *   - `cardActivity` notifications so card badges flash on output
 *   - local React state for `status` so the pane header updates
 *
 * Whether the agent is busy is not decided here — it comes from the server on
 * `ConvInfo.activity`.
 *   - `visualViewport.resize` fit so the virtual keyboard doesn't leave the
 *     terminal with the wrong dimensions
 */
export function useTerminal(
  containerRef: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
): UseTerminalApi {
  const [status, setStatus] = useState<TerminalStatus>('connecting')

  const theme = useMemo(
    () => ({
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
    }),
    [],
  )

  const xtermOptions = useMemo(() => ({ allowProposedApi: true }), [])

  const { termRef, sendData, scheduleFit } = useTerminalCore({
    containerRef,
    sessionId,
    theme,
    fontSize: 13,
    fontFamily:
      "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
    xtermOptions,
    onActivity: (id) => cardActivity.onOutput(id),
    onStatusChange: setStatus,
  })

  // Phones with on-screen keyboards fire visualViewport.resize when the
  // keyboard opens/closes; re-run the core's fit pipeline (fit xterm +
  // SIGWINCH to the PTY) so the layout matches the new visible area.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    vv.addEventListener('resize', scheduleFit)
    return () => {
      vv.removeEventListener('resize', scheduleFit)
    }
  }, [scheduleFit])

  const sendText = (s: string) => sendData(s)
  const sendKey = sendText

  return { sendText, sendKey, status, termRef }
}
