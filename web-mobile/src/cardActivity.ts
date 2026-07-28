import { useSyncExternalStore } from 'react'

/**
 * Unread-burst counter: counts "completed bursts" (sustained output ending in
 * a period of silence) that arrive while the card is not being viewed. For
 * Claude specifically this is a decent proxy for "a new message just finished
 * arriving". Reset to 0 when the user activates the card.
 *
 * Terminal has no native message concept, so we approximate:
 *   - Output chunk arrives → reset the idle timer
 *   - No output for BURST_IDLE_MS → burst ended
 *     - If card was NOT the active view → increment completed count
 *     - Else → silent (user is already watching)
 *
 * This deliberately still watches output volume, because "something was
 * printed since you last looked" IS a statement about output. Whether the
 * agent is busy is a different question, answered by `ConvInfo.activity`.
 */

const BURST_IDLE_MS = 2000

export interface CardActivity {
  lastOutputAt: number
  completedBursts: number
}

const EMPTY: CardActivity = {
  lastOutputAt: 0,
  completedBursts: 0,
}

type Listener = () => void

const state = new Map<string, CardActivity>()
const listeners = new Set<Listener>()
const burstTimers = new Map<string, ReturnType<typeof setTimeout>>()
let activeId: string | null = null

function emit() {
  listeners.forEach((l) => l())
}

function get(id: string): CardActivity {
  return state.get(id) ?? EMPTY
}

function set(id: string, next: CardActivity) {
  state.set(id, next)
}

function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const cardActivity = {
  /** Called by useTerminal on every PTY output chunk. */
  onOutput(id: string) {
    const curr = get(id)
    set(id, { ...curr, lastOutputAt: Date.now() })

    const existing = burstTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      const a = get(id)
      // Burst ended. Count it only if user wasn't looking at this card.
      const bumpCount = activeId !== id
      set(id, {
        ...a,
        completedBursts: a.completedBursts + (bumpCount ? 1 : 0),
      })
      burstTimers.delete(id)
      emit()
    }, BURST_IDLE_MS)
    burstTimers.set(id, timer)

    emit()
  },

  /** Called by App when the active card changes. Pass null when leaving to overview. */
  setActive(id: string | null) {
    activeId = id
    if (id) {
      const curr = get(id)
      if (curr.completedBursts !== 0) {
        set(id, { ...curr, completedBursts: 0 })
      }
    }
    emit()
  },

  /** Drop a card's tracking state (e.g., when removed from stack). */
  forget(id: string) {
    state.delete(id)
    const t = burstTimers.get(id)
    if (t) clearTimeout(t)
    burstTimers.delete(id)
    emit()
  },
}

export function useCardActivity(id: string): CardActivity {
  return useSyncExternalStore(
    subscribe,
    () => get(id),
    () => EMPTY,
  )
}
