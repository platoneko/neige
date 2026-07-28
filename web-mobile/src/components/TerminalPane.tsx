import { useEffect, useRef } from 'react'
import { useTerminal } from '../useTerminal'
import type { ConvInfo } from '../types'
import { ComposeBar } from './ComposeBar'
import { KeyBar } from './KeyBar'
import { ScrollEdge } from './ScrollEdge'
import { JumpToBottom } from './JumpToBottom'

interface Props {
  conv: ConvInfo
  active: boolean
  onOverview: () => void
  onPrev: () => void
  onNext: () => void
  canCycle: boolean
}

/**
 * One card's terminal. Rendered for every card in the stack; inactive panes
 * stay mounted with live WS + xterm, only hidden via CSS (see `.term-pane`).
 * This is what makes card-switching feel instant.
 */
export function TerminalPane({ conv, active, onOverview, onPrev, onNext, canCycle }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { sendText, sendKey, status, termRef } = useTerminal(ref, conv.id)

  // Drag-to-scroll inside the terminal body. xterm captures touches for text
  // selection by default, so we intercept and drive the viewport ourselves.
  //
  // Design:
  //   - 1:1 pixel-to-pixel feel: ratio derived from measured line height
  //     (body height / term.rows) so a 16px finger drag moves 16px of content.
  //   - xterm's scrollLines is integer-only, so we accumulate the float
  //     remainder between moves — no "2px dead zone then jump" feel.
  //   - Fling: release velocity continues scrolling with exponential decay,
  //     matching native iOS momentum.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return

    const FLING_DECAY_PER_MS = 0.995 // velocity halves in ~140ms
    const FLING_MIN_VELOCITY = 0.002 // lines per ms — below this we stop
    const FLING_TRIGGER_VELOCITY = 0.01 // only fling if released above this

    let dragging = false
    let startY = 0
    let startLine = 0
    let accum = 0 // float line remainder carried across moves
    let lineHeight = 16
    let lastY = 0
    let lastT = 0
    let velocity = 0 // lines/ms, signed: negative = scroll up (older content)
    let flingRaf = 0

    const cancelFling = () => {
      if (flingRaf) {
        cancelAnimationFrame(flingRaf)
        flingRaf = 0
      }
    }

    const measureLineHeight = () => {
      const term = termRef.current
      if (!term || term.rows <= 0) return 16
      const rect = el.getBoundingClientRect()
      return rect.height / term.rows
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const target = e.target as HTMLElement
      if (target.closest('.scroll-edge, .jump-bottom')) return
      const term = termRef.current
      if (!term) return
      cancelFling()
      dragging = true
      startY = e.touches[0].clientY
      lastY = startY
      lastT = performance.now()
      startLine = term.buffer.active.viewportY
      accum = 0
      lineHeight = measureLineHeight()
      velocity = 0
    }

    const onMove = (e: TouchEvent) => {
      if (!dragging) return
      const term = termRef.current
      if (!term) return
      const y = e.touches[0].clientY
      const now = performance.now()

      // Total drag delta in lines (float). Content-style: finger down →
      // viewportY decreases (see older content above).
      const desiredLine = startLine - (y - startY) / lineHeight
      const baseY = term.buffer.active.baseY
      const clampedFloat = Math.max(0, Math.min(desiredLine, baseY))
      // Integer portion → scroll; sub-line fraction carried in `accum` so it
      // doesn't get thrown away frame-to-frame.
      const target = Math.round(clampedFloat)
      const delta = target - term.buffer.active.viewportY
      if (delta !== 0) term.scrollLines(delta)
      accum = clampedFloat - target

      // Per-move velocity for fling. Only recent samples matter; overwrite.
      const dy = y - lastY
      const dt = Math.max(1, now - lastT)
      velocity = -dy / lineHeight / dt
      lastY = y
      lastT = now

      e.preventDefault()
    }

    const startFling = () => {
      let prev = performance.now()
      const step = (now: number) => {
        const dt = now - prev
        prev = now
        accum += velocity * dt
        velocity *= Math.pow(FLING_DECAY_PER_MS, dt)
        const term = termRef.current
        if (!term) {
          flingRaf = 0
          return
        }
        const lines = Math.trunc(accum)
        if (lines !== 0) {
          const before = term.buffer.active.viewportY
          term.scrollLines(lines)
          const after = term.buffer.active.viewportY
          accum -= lines
          // Hit buffer boundary — stop trying, finger is done anyway.
          if (after === before) {
            flingRaf = 0
            return
          }
        }
        if (Math.abs(velocity) > FLING_MIN_VELOCITY) {
          flingRaf = requestAnimationFrame(step)
        } else {
          flingRaf = 0
        }
      }
      flingRaf = requestAnimationFrame(step)
    }

    const onEnd = () => {
      if (!dragging) return
      dragging = false
      if (Math.abs(velocity) > FLING_TRIGGER_VELOCITY) startFling()
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      cancelFling()
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [termRef])

  return (
    <div className="term-pane" data-active={active}>
      <header className="term-header">
        <button className="icon-btn" onClick={onOverview} aria-label="overview">
          ⊟
        </button>
        <div className="term-title-wrap">
          <div className="term-title">{conv.title}</div>
          <div className="term-status">
            <span className={`status-dot status-${conv.status}`} />
            <span>{status}</span>
          </div>
        </div>
        <button
          className="icon-btn"
          onClick={onPrev}
          disabled={!canCycle}
          aria-label="previous"
        >
          ‹
        </button>
        <button
          className="icon-btn"
          onClick={onNext}
          disabled={!canCycle}
          aria-label="next"
        >
          ›
        </button>
      </header>
      <div className="term-body" ref={bodyRef}>
        <div className="term-host" ref={ref} />
        <ScrollEdge termRef={termRef} />
        <JumpToBottom termRef={termRef} />
      </div>
      <KeyBar
        onKey={sendKey}
        onAction={(action) => {
          if (action === 'scrollBottom') termRef.current?.scrollToBottom()
        }}
      />
      <ComposeBar
        busy={conv.activity === 'working'}
        onSend={sendText}
        onStop={() => sendText('\x1b')}
      />
    </div>
  )
}
