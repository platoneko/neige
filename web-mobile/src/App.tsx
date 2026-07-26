import { useEffect, useState } from 'react'
import { useToast } from '@neige/shared'
import './App.css'
import { useAuth } from './useAuth'
import { useConversations } from './useConversations'
import { useCardStack } from './useCardStack'
import { cardActivity } from './cardActivity'
import {
  createConversation,
  deleteConversation,
  logout as apiLogout,
  renameConversation,
} from './api'
import { Login } from './components/Login'
import { Overview } from './components/Overview'
import { TerminalPane } from './components/TerminalPane'
import { ChatPane } from './components/ChatPane'
import { AddSheet } from './components/AddSheet'
import { CardMenu } from './components/CardMenu'

function App() {
  const { state: authState, markAuthed, markAnonymous } = useAuth()
  const { conversations, connected, refresh } = useConversations()
  const stack = useCardStack()
  const { toast } = useToast()
  const [showAdd, setShowAdd] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)

  // Let the activity store know which card is "currently viewed" — bursts that
  // complete while this is null or a different id are counted as unread.
  useEffect(() => {
    const viewed = stack.view === 'card' ? stack.activeId : null
    cardActivity.setActive(viewed)
  }, [stack.view, stack.activeId])

  // Removing a card must also tear down its activity state + any pending
  // burst timer, otherwise they linger in memory and can fire against an id
  // that's no longer in the stack.
  const removeCard = (id: string) => {
    stack.remove(id)
    cardActivity.forget(id)
  }

  if (authState === 'checking') {
    return <div className="boot-screen">loading…</div>
  }
  if (authState === 'anonymous') {
    return <Login onAuthed={markAuthed} />
  }

  const byId = new Map(conversations.map((c) => [c.id, c]))
  const menuConv = menuId ? byId.get(menuId) : null

  return (
    <div className="app-root">
      {/* Pane host: always mounted so inactive card terminals stay live.
          visibility:hidden when overview is on top — keeps xterm dimensions. */}
      <div className="pane-host" data-visible={stack.view === 'card'}>
        {stack.cards.map((id) => {
          const conv = byId.get(id)
          if (!conv) return null
          const Pane = conv.mode === 'chat' ? ChatPane : TerminalPane
          return (
            <Pane
              key={id}
              conv={conv}
              active={stack.view === 'card' && id === stack.activeId}
              onOverview={stack.showOverview}
              onPrev={() => stack.cycle(-1)}
              onNext={() => stack.cycle(1)}
              canCycle={stack.cards.length > 1}
            />
          )
        })}
      </div>

      {stack.view === 'overview' && (
        <Overview
          cards={stack.cards}
          conversations={conversations}
          connected={connected}
          onActivate={stack.activate}
          onRemove={removeCard}
          onLongPress={(id) => setMenuId(id)}
          onAdd={() => setShowAdd(true)}
          onLogout={async () => {
            await apiLogout()
            markAnonymous()
          }}
        />
      )}

      {menuConv && (
        <CardMenu
          conv={menuConv}
          conversations={conversations}
          onRename={async (title) => {
            try {
              await renameConversation(menuConv.id, title)
              await refresh()
            } catch (err) {
              toast({
                variant: 'error',
                title: 'Rename failed',
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
          onDelete={async () => {
            try {
              await deleteConversation(menuConv.id)
              removeCard(menuConv.id)
              await refresh()
            } catch (err) {
              toast({
                variant: 'error',
                title: 'Delete failed',
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
          onClose={() => setMenuId(null)}
        />
      )}

      {showAdd && (
        <AddSheet
          conversations={conversations}
          inStack={stack.cards}
          onPickExisting={(id) => {
            stack.add(id)
            setShowAdd(false)
          }}
          onPickMany={(ids) => {
            stack.addMany(ids)
            setShowAdd(false)
          }}
          onCreate={async (req) => {
            const conv = await createConversation(req)
            await refresh()
            stack.add(conv.id)
            setShowAdd(false)
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  )
}

export default App
