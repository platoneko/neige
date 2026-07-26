import { useState } from 'react'
import { Sheet, SheetContent } from '@neige/shared'
import { Box, Button, Callout, Flex, Text, TextField } from '@radix-ui/themes'
import type { ConvInfo } from '../types'

interface Props {
  conv: ConvInfo
  /** Whole list, only so the delete confirmation can count this card's
   *  child agents. The overview renders a flat list with no hierarchy
   *  cues, so nothing else on screen hints that a card is a task root. */
  conversations: ConvInfo[]
  onRename: (title: string) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}

export function CardMenu({ conv, conversations, onRename, onDelete, onClose }: Props) {
  const [mode, setMode] = useState<'menu' | 'rename' | 'confirmDelete'>('menu')
  const [newTitle, setNewTitle] = useState(conv.title)
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)

  // The server cascades a root's delete to its children, so this card can
  // take sessions with it that the user never selected — and a flat list
  // gives them no way to see that coming. Say the count out loud instead.
  const childCount = conversations.filter((c) => c.parent_id === conv.id).length

  const doRename = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = newTitle.trim()
    if (!t || t === conv.title) {
      onClose()
      return
    }
    setPending(true)
    setErr(null)
    try {
      await onRename(t)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const doDelete = async () => {
    setPending(true)
    setErr(null)
    try {
      await onDelete()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPending(false)
    }
  }

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(conv.id)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
        onClose()
      }, 800)
    } catch {
      prompt('复制这个 ID：', conv.id)
      onClose()
    }
  }

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent>
        <Flex direction="column" gap="3">
          <Flex justify="between" align="start" gap="3">
            <Box style={{ minWidth: 0 }}>
              <Text as="div" size="3" weight="medium" truncate>
                {conv.title}
              </Text>
              <Text as="div" size="1" color="gray" style={{ fontFamily: 'var(--code-font-family)' }}>
                {conv.id.slice(0, 8)}…
              </Text>
            </Box>
            <Button variant="ghost" color="gray" onClick={onClose}>
              取消
            </Button>
          </Flex>

          {mode === 'menu' && (
            <Flex direction="column" gap="2" mt="2">
              <MenuRow icon="✎" onClick={() => setMode('rename')}>
                重命名
              </MenuRow>
              <MenuRow icon="⧉" onClick={copyId}>
                {copied ? '已复制' : '复制 session ID'}
              </MenuRow>
              <MenuRow icon="✕" danger onClick={() => setMode('confirmDelete')}>
                删除 session（不可撤销）
              </MenuRow>
            </Flex>
          )}

          {mode === 'rename' && (
            <form onSubmit={doRename}>
              <Flex direction="column" gap="3">
                <TextField.Root
                  size="3"
                  value={newTitle}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                {err && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{err}</Callout.Text>
                  </Callout.Root>
                )}
                <Flex gap="3" justify="end">
                  <Button
                    type="button"
                    size="3"
                    variant="soft"
                    color="gray"
                    onClick={() => setMode('menu')}
                    disabled={pending}
                  >
                    返回
                  </Button>
                  <Button type="submit" size="3" disabled={pending}>
                    {pending ? '保存中…' : '保存'}
                  </Button>
                </Flex>
              </Flex>
            </form>
          )}

          {mode === 'confirmDelete' && (
            <Flex direction="column" gap="3">
              <Callout.Root color="red" size="2">
                <Callout.Text>
                  {childCount > 0 ? (
                    <>
                      确认删除任务 <strong>{conv.title}</strong> 及其 {childCount} 个 agent？
                      <br />
                      这些 session 的 PTY 都会被杀掉，所有客户端（桌面 + 其他手机）都会断开。
                    </>
                  ) : (
                    <>
                      确认删除 <strong>{conv.title}</strong>？
                      <br />
                      该 session 的 PTY 会被杀掉，所有客户端（桌面 + 其他手机）都会断开。
                    </>
                  )}
                </Callout.Text>
              </Callout.Root>
              {err && (
                <Callout.Root color="red" size="1">
                  <Callout.Text>{err}</Callout.Text>
                </Callout.Root>
              )}
              <Flex gap="3" justify="end">
                <Button
                  type="button"
                  size="3"
                  variant="soft"
                  color="gray"
                  onClick={() => setMode('menu')}
                  disabled={pending}
                >
                  算了
                </Button>
                <Button
                  type="button"
                  size="3"
                  color="red"
                  onClick={doDelete}
                  disabled={pending}
                >
                  {pending ? '删除中…' : '确认删除'}
                </Button>
              </Flex>
            </Flex>
          )}
        </Flex>
      </SheetContent>
    </Sheet>
  )
}

function MenuRow({
  icon,
  children,
  danger,
  onClick,
}: {
  icon: string
  children: React.ReactNode
  danger?: boolean
  onClick: () => void
}) {
  return (
    <Button
      size="3"
      variant="soft"
      color={danger ? 'red' : 'gray'}
      onClick={onClick}
      style={{ justifyContent: 'flex-start', width: '100%' }}
    >
      <Text style={{ width: 24, textAlign: 'center' }}>{icon}</Text>
      <Text>{children}</Text>
    </Button>
  )
}
