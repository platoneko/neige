import { Badge, Box, Button, Card, Flex, Heading, IconButton, Text } from '@radix-ui/themes'
import { MessageSquare, Terminal } from 'lucide-react'
import type { ConvInfo } from '../types'
import { useCardActivity } from '../cardActivity'
import { useLongPress } from '../useLongPress'

interface Props {
  cards: string[]
  conversations: ConvInfo[]
  connected: boolean
  onActivate: (id: string) => void
  onRemove: (id: string) => void
  onLongPress: (id: string) => void
  onAdd: () => void
  onLogout: () => void
}

function ModeIcon({ mode }: { mode: ConvInfo['mode'] }) {
  const Icon = mode === 'chat' ? MessageSquare : Terminal
  return (
    <Icon
      size={14}
      strokeWidth={2}
      style={{ color: 'var(--gray-9)', flex: '0 0 auto' }}
      aria-label={mode}
    />
  )
}

function shortCwd(cwd: string): string {
  const home = '/home/'
  if (cwd.startsWith(home)) {
    const rest = cwd.slice(home.length)
    const slash = rest.indexOf('/')
    return slash === -1 ? `~${rest}` : `~${rest.slice(slash)}`
  }
  return cwd
}

export function Overview({
  cards,
  conversations,
  connected,
  onActivate,
  onRemove,
  onLongPress,
  onAdd,
  onLogout,
}: Props) {
  const byId = new Map(conversations.map((c) => [c.id, c]))
  const items = cards.map((id) => byId.get(id)).filter((c): c is ConvInfo => !!c)
  const orphans = cards.length - items.length

  return (
    <Flex direction="column" className="overview">
      <Flex
        align="center"
        justify="between"
        px="4"
        py="3"
        style={{
          borderBottom: '1px solid var(--gray-a5)',
          background: 'var(--color-panel-solid)',
        }}
      >
        <Box>
          <Heading size="4" weight="medium">neige</Heading>
          <Text size="1" color="gray">
            {connected ? `${items.length} cards in stack` : 'reconnecting…'}
          </Text>
        </Box>
        <Button variant="ghost" color="gray" onClick={onLogout}>
          logout
        </Button>
      </Flex>

      <Box p="3" style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 && (
          <Box py="8" style={{ textAlign: 'center' }}>
            <Text as="div" size="3" color="gray">栈是空的</Text>
            <Text as="div" size="1" color="gray" mt="2">
              点下面 + 从已有会话里挑一个加进来
            </Text>
          </Box>
        )}

        <Flex direction="column" gap="2">
          {items.map((c) => (
            <OverviewCard
              key={c.id}
              conv={c}
              onActivate={() => onActivate(c.id)}
              onRemove={() => onRemove(c.id)}
              onLongPress={() => onLongPress(c.id)}
            />
          ))}
        </Flex>

        {orphans > 0 && (
          <Box
            mt="3"
            p="3"
            style={{
              textAlign: 'center',
              border: '1px dashed var(--gray-a5)',
              borderRadius: 'var(--radius-3)',
            }}
          >
            <Text size="1" color="gray">
              {orphans} card(s) 已从 server 消失，已保留占位
            </Text>
          </Box>
        )}
      </Box>

      <IconButton
        size="4"
        radius="full"
        onClick={onAdd}
        aria-label="add card"
        style={{
          position: 'absolute',
          right: 20,
          bottom: 'calc(20px + env(safe-area-inset-bottom))',
          width: 56,
          height: 56,
          fontSize: 28,
        }}
      >
        +
      </IconButton>
    </Flex>
  )
}

function OverviewCard({
  conv,
  onActivate,
  onRemove,
  onLongPress,
}: {
  conv: ConvInfo
  onActivate: () => void
  onRemove: () => void
  onLongPress: () => void
}) {
  const activity = useCardActivity(conv.id)
  const hasUnread = activity.completedBursts > 0
  const longPress = useLongPress(onLongPress, 450)

  const statusColor =
    conv.status === 'running' ? 'var(--green-9)' :
    conv.status === 'detached' ? 'var(--yellow-9)' : 'var(--gray-8)'

  return (
    <Card
      style={{
        padding: 0,
        overflow: 'hidden',
        borderColor: hasUnread ? 'var(--accent-a7)' : undefined,
      }}
    >
      <Flex align="stretch" style={{ minHeight: 64 }}>
        <Box
          onClick={() => { if (!longPress.didFire()) onActivate() }}
          onTouchStart={longPress.onTouchStart}
          onTouchMove={longPress.onTouchMove}
          onTouchEnd={longPress.onTouchEnd}
          onTouchCancel={longPress.onTouchCancel}
          onContextMenu={longPress.onContextMenu}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '14px 14px 14px 16px',
            cursor: 'pointer',
          }}
        >
          <Flex align="center" gap="2" mb="1" style={{ minWidth: 0 }}>
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusColor,
                flex: '0 0 auto',
              }}
            />
            <ModeIcon mode={conv.mode} />
            <Text size="3" weight="medium" truncate>{conv.title}</Text>
            {conv.activity === 'working' && (
              <span
                title="working…"
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--green-9)',
                  marginLeft: 2,
                  animation: 'pulse-green 1.4s ease-in-out infinite',
                }}
              />
            )}
            {/* Steady, not pulsing: this one isn't going to resolve on its
                own, so it shouldn't read as activity in progress. */}
            {conv.activity === 'awaiting_input' && (
              <span
                title="waiting for you"
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--yellow)',
                  marginLeft: 2,
                }}
              />
            )}
          </Flex>
          <Text
            as="div"
            size="1"
            color="gray"
            truncate
            style={{ fontFamily: 'var(--code-font-family)' }}
          >
            {shortCwd(conv.effective_cwd)}
          </Text>
        </Box>
        {hasUnread && (
          <Flex align="center" pr="2">
            <Badge color="red" variant="solid" radius="full">
              {activity.completedBursts > 99 ? '99+' : activity.completedBursts}
            </Badge>
          </Flex>
        )}
        <Box
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            width: 44,
            borderLeft: '1px solid var(--gray-a5)',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: 'var(--gray-10)',
          }}
          aria-label="remove from stack"
        >
          ✕
        </Box>
      </Flex>
    </Card>
  )
}
