import { useEffect, useState } from 'react'
import { ChevronRight, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { formatUsage } from '@/lib/format'
import { useLiveCalls } from '@/hooks/useLiveCalls'
import LiveOutput from '@/components/LiveOutput'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

function formatDuration(ms) {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function RawBlock({ label, text }) {
  if (!text) return null
  const copy = () => navigator.clipboard.writeText(text).then(() => toast.success(`已复制${label}`))
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{label} · {text.length.toLocaleString()} 字</span>
        <button onClick={copy} className="flex items-center gap-1 hover:text-foreground"><Copy className="size-3" /> 复制</button>
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed">{text}</pre>
    </div>
  )
}

// One recorded CLI call in full: what was sent, what came back (raw), and how it ran.
export function AICallDetail({ jobId, callId }) {
  const [call, setCall] = useState(null)
  useEffect(() => { api.get(`/api/job/${jobId}/ai_calls/${callId}`).then(setCall) }, [jobId, callId])

  if (!call) return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{call.provider}</span>
        {call.command?.length > 0 && <code className="rounded bg-muted px-1">{call.command.join(' ')}</code>}
        <span>耗时 {formatDuration(call.duration_ms)}</span>
        {call.returncode != null && <span>退出码 {call.returncode}</span>}
        {call.usage && <span>{formatUsage(call.usage)}</span>}
        {call.usage?.models?.length > 0 && <span>{call.usage.models.join(', ')}</span>}
      </div>
      {call.error && <p className="rounded-md bg-destructive/5 p-2 text-xs text-destructive">{call.error}</p>}
      <RawBlock label="发送的 prompt" text={call.prompt} />
      <RawBlock label="CLI 原始输出" text={call.stdout} />
      <RawBlock label="stderr" text={call.stderr} />
    </div>
  )
}

export function AICallDialog({ jobId, callId, onClose }) {
  return (
    <Dialog open={!!callId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>CLI 调用记录</DialogTitle></DialogHeader>
        {callId && <AICallDetail jobId={jobId} callId={callId} />}
      </DialogContent>
    </Dialog>
  )
}

// Every AI CLI call made for this job, newest first; click one to expand it in full.
export function AICallLog({ jobId, count, liveCount }) {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const live = useLiveCalls(jobId, liveCount > 0)
  useEffect(() => { api.get(`/api/job/${jobId}/ai_calls`).then(setData) }, [jobId, count])

  if (!data) return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  const calls = data.calls || []
  if (!calls.length && !live.length) return <p className="text-sm text-muted-foreground">这个任务还没有调用过 AI。</p>

  return (
    <div>
      <h3 className="mb-1 font-semibold">AI 调用记录</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        这个任务每次调用 AI CLI 的完整输入和原始输出。
        {data.total?.calls > 0 && <> 合计 {data.total.calls} 次 · {formatUsage(data.total)}</>}
      </p>
      {live.length > 0 && (
        <div className="mb-4 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          {live.map((c) => <LiveOutput key={c.id} text={c.text} label={`${c.purpose} · 进行中`} />)}
        </div>
      )}
      <div className="divide-y rounded-lg border">
        {calls.map((c) => (
          <div key={c.id}>
            <button
              onClick={() => setOpen(open === c.id ? null : c.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent/50"
            >
              <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open === c.id && 'rotate-90')} />
              <span className="font-medium">{c.purpose}</span>
              {c.error && <span className="text-xs text-destructive">失败</span>}
              <span className="ml-auto flex shrink-0 gap-4 text-xs text-muted-foreground">
                {c.usage ? <span>{formatUsage(c.usage)}</span> : <span>{c.prompt_chars.toLocaleString()} → {c.output_chars.toLocaleString()} 字</span>}
                <span className="w-12 text-right">{formatDuration(c.duration_ms)}</span>
                <span>{new Date(c.ts).toLocaleString()}</span>
              </span>
            </button>
            {open === c.id && (
              <div className="border-t bg-muted/20 px-4 py-4">
                <AICallDetail jobId={jobId} callId={c.id} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
