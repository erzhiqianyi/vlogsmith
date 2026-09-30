import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUp, Check, PanelRightClose, Search, Sparkles, X } from 'lucide-react'
import { api } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { useLiveCalls } from '@/hooks/useLiveCalls'
import { formatUsage } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { AICallDialog } from '@/components/AICalls'
import LiveOutput from '@/components/LiveOutput'

const OPEN_KEY = 'chatPanelOpen'
const SEEN_KEY = (jobId) => `chatSeen:${jobId}`
const STEP_LABELS = { transcript: '字幕', blog: '博客', caption: '封面', export: '导出', podcast: '视频播客', info: '基本信息' }

function readStorage(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

function EventLine({ msg }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <Check className="size-3" />
      <span className="max-w-[260px] truncate">{msg.text}</span>
      <span className="text-faint">{new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function UserBubble({ msg }) {
  return (
    <div className="max-w-[300px] self-end whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ink px-3.5 py-2.5 text-sm leading-relaxed text-background">
      {msg.text}
      {msg.selected_indices?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {msg.selected_indices.map((i) => (
            <span key={i} className="rounded-full bg-background/15 px-2 text-xs">#{i}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantCard({ msg, liveText, providerLabel, onOpenCall, onLocate }) {
  const [expanded, setExpanded] = useState(false)
  if (msg.status === 'pending') {
    return <LiveOutput text={liveText} label={`${providerLabel || 'AI'} 正在处理`} />
  }
  if (msg.status === 'error') {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-[13px] text-destructive">
        {msg.text}
      </div>
    )
  }
  const corrections = msg.corrections || []
  const shown = expanded ? corrections : corrections.slice(0, 3)
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-sm leading-relaxed">
      <p className="whitespace-pre-wrap">{msg.text || (corrections.length ? `改了 ${corrections.length} 条字幕` : '没有找到需要改的地方')}</p>
      {corrections.length > 0 && (
        <ul className="flex flex-col gap-1 text-[13px]">
          {shown.map((c) => (
            <li key={c.index} className="flex gap-2">
              <button onClick={() => onLocate?.(c.index)} className="w-8 shrink-0 text-left font-mono text-faint hover:text-primary" title="在字幕里定位">#{c.index}</button>
              <span className="min-w-0">
                <span className="text-faint line-through">{c.original}</span>
                <span className="mx-1 text-faint">→</span>
                <span className="text-primary-soft-foreground">{c.fixed || '（删掉）'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {corrections.length > 3 && (
        <button onClick={() => setExpanded((v) => !v)} className="self-start text-[13px] text-primary hover:underline">
          {expanded ? '收起' : `另外 ${corrections.length - 3} 条 · 展开`}
        </button>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-faint">
        {providerLabel && <span>{providerLabel}</span>}
        <span>{new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {msg.usage?.calls > 0 && <span>{formatUsage(msg.usage)}</span>}
        {msg.call_ids?.map((id, i) => (
          <button key={id} onClick={() => onOpenCall(id)} className="text-muted-foreground hover:text-foreground hover:underline">
            完整调用{msg.call_ids.length > 1 ? ` ${i + 1}` : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The job's AI assistant, docked on the right of every job page. The history is one
 * stream per job: typed instructions, the AI's replies, and the buttons clicked in
 * the page (logged as `event` lines by the page itself). `chips` are the current
 * page's quick actions; `canInstruct` says whether free-form instructions are wired
 * up for this page (so far only the transcript step has an AI editing backend).
 */
export default function ChatPanel({ jobId, step, pending, bridge, onCorrections, chips = [], canInstruct, chatVersion }) {
  const [open, setOpen] = useState(() => readStorage(OPEN_KEY, '1') !== '0')
  const [scope, setScope] = useState('step')
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState('')
  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState(false)
  const [callId, setCallId] = useState(null)
  const [provider, setProvider] = useState(null)
  const scrollRef = useRef(null)

  useEffect(() => { writeStorage(OPEN_KEY, open ? '1' : '0') }, [open])

  const busy = sending || pending
  const { data, refresh } = usePolling(() => api.get(`/api/job/${jobId}/chat`), {
    intervalMs: busy ? 1500 : 10000, deps: [jobId],
  })
  useEffect(() => { refresh().catch(() => {}) }, [chatVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: aiConfig } = usePolling(() => api.get('/api/ai/config'), { intervalMs: 60000 })
  const providers = useMemo(() => Object.entries(aiConfig?.providers || {})
    .filter(([, p]) => p.command?.length)
    .map(([name, p]) => ({ name, label: p.label || name })), [aiConfig])
  const activeProvider = provider || aiConfig?.active
  const labelOf = (name) => providers.find((p) => p.name === name)?.label || name

  const messages = data?.messages || []
  const live = useLiveCalls(jobId, open && busy)
  const liveByTag = Object.fromEntries(live.filter((c) => c.tag).map((c) => [c.tag, c.text]))

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return messages.filter((m) => (
      (scope === 'all' || (m.step || 'transcript') === step)
      && (!q || (m.text || '').toLowerCase().includes(q) || (m.corrections || []).some((c) => c.fixed.toLowerCase().includes(q)))
    ))
  }, [messages, scope, step, search])

  // Unread = assistant replies that landed while the panel was collapsed.
  const [seenAt, setSeenAt] = useState(() => readStorage(SEEN_KEY(jobId), ''))
  const lastTs = messages.length ? messages[messages.length - 1].ts : ''
  useEffect(() => {
    if (open && lastTs && lastTs !== seenAt) { setSeenAt(lastTs); writeStorage(SEEN_KEY(jobId), lastTs) }
  }, [open, lastTs, seenAt, jobId])
  const unread = messages.filter((m) => m.role === 'assistant' && m.status !== 'pending' && m.ts > seenAt).length

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [visible.length, open, lastTs, live.map((c) => c.text.length).join()])

  const selection = bridge?.selection || []

  const send = () => {
    const text = instruction.trim()
    if (!text || busy || !canInstruct) return
    setSending(true)
    setInstruction('')
    setTimeout(() => refresh().catch(() => {}), 300)
    api.post(`/api/job/${jobId}/ai_instruct`, {
      instruction: text, selected_indices: selection.map((s) => s.index), provider: activeProvider,
    })
      .then((d) => {
        if (d?.error) return
        const corrections = d?.corrections || []
        bridge?.clear()
        if (!corrections.length) return
        if (bridge) bridge.onResult(corrections)
        else onCorrections?.()
      })
      .catch(() => toast.error('请求失败'))
      .finally(() => { setSending(false); refresh().catch(() => {}) })
  }

  if (!open) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-3 border-l bg-paper pt-3">
        <button
          onClick={() => setOpen(true)} aria-label="展开 AI 助手"
          className="relative flex size-11 items-center justify-center rounded-lg border bg-card text-primary hover:bg-secondary"
        >
          <Sparkles className={cn('size-[18px]', busy && 'animate-pulse')} />
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[18px] rounded-full bg-primary px-1.5 text-center text-[11px] leading-[18px] text-primary-foreground">{unread}</span>
          )}
        </button>
        <span className="text-xs tracking-[0.2em] text-muted-foreground [writing-mode:vertical-rl]">AI 助手</span>
      </aside>
    )
  }

  return (
    <aside aria-label="AI 助手" className="flex w-[400px] shrink-0 flex-col border-l bg-paper">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b pr-2 pl-5">
        <Sparkles className="size-4 text-primary" />
        <h2 className="text-sm font-bold">AI 助手</h2>
        <span className="text-xs text-muted-foreground">{STEP_LABELS[step]}</span>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger size="sm" className="ml-auto bg-card text-xs data-[size=sm]:h-8"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="step">本步骤</SelectItem>
            <SelectItem value="all">全部记录</SelectItem>
          </SelectContent>
        </Select>
        <button
          onClick={() => { setSearching((v) => !v); setSearch('') }} aria-label="搜索对话记录"
          className={cn('flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary', searching && 'bg-secondary text-foreground')}
        >
          <Search className="size-4" />
        </button>
        <button onClick={() => setOpen(false)} aria-label="收起 AI 助手" className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary">
          <PanelRightClose className="size-4" />
        </button>
      </div>
      {searching && (
        <div className="border-b px-4 py-2">
          <input
            autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索对话记录"
            aria-label="搜索对话记录"
            className="h-9 w-full rounded-lg border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
      )}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        {visible.length === 0 ? (
          <p className="m-auto max-w-[260px] text-center text-sm leading-relaxed text-muted-foreground">
            {search ? '没有匹配的记录' : canInstruct
              ? '告诉 AI 这条 vlog 要怎么改。勾选的字幕行会一起带上，你在页面上点的操作也会记在这里。'
              : `你在这个页面上的操作会记在这里。${chips.length ? '下面的快捷操作也可以直接点。' : ''}`}
          </p>
        ) : visible.map((m) => {
          if (m.role === 'event') return <EventLine key={m.id} msg={m} />
          if (m.role === 'user') return <UserBubble key={m.id} msg={m} />
          return (
            <AssistantCard
              key={m.id} msg={m} liveText={liveByTag[m.id]} providerLabel={m.provider && labelOf(m.provider)}
              onOpenCall={setCallId} onLocate={bridge?.locate}
            />
          )
        })}
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 border-t px-4 pt-3 pb-4">
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.label} onClick={c.run} disabled={c.disabled}
                className="h-8 rounded-full border bg-card px-3 text-[13px] whitespace-nowrap hover:bg-secondary disabled:opacity-50"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {selection.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selection.map((s) => (
              <span key={s.index} className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary-soft-foreground">
                <span className="truncate">#{s.index} {s.text?.slice(0, 12)}</span>
                <button onClick={() => bridge.remove(s.index)} aria-label={`取消选择第 ${s.index} 行`}><X className="size-3" /></button>
              </span>
            ))}
          </div>
        )}
        <div className={cn('flex h-11 items-center gap-2 rounded-lg border border-[#CFC9BB] bg-card pr-1.5 pl-1.5', !canInstruct && 'opacity-60')}>
          {providers.length > 0 && (
            <Select value={activeProvider} onValueChange={setProvider}>
              <SelectTrigger size="sm" aria-label="选择 AI 命令行工具" className="max-w-[150px] shrink-0 border-0 bg-secondary px-2 text-xs font-medium shadow-none data-[size=sm]:h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => <SelectItem key={p.name} value={p.name}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <label className="sr-only" htmlFor="chat-input">给 AI 的指令</label>
          <input
            id="chat-input"
            value={instruction} onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send() }}
            disabled={!canInstruct}
            placeholder={canInstruct ? '告诉 AI 要做什么' : chips.length ? '这一步暂时用上面的快捷操作' : '这一步还不能用自由指令'}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <button
            onClick={send} disabled={!canInstruct || busy || !instruction.trim()} aria-label="发送"
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>

      {callId && <AICallDialog jobId={jobId} callId={callId} onClose={() => setCallId(null)} />}
    </aside>
  )
}
