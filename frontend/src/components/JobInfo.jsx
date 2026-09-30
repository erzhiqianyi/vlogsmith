import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ExternalLink, Loader2, Maximize2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, coverUrl, jobFileUrl } from '@/lib/api'
import { PODCAST_LABELS, STAGE_LABELS } from '@/lib/format'
import { STEPS, stepState } from '@/lib/steps'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { AICallLog } from '@/components/AICalls'
import EventLog from '@/components/EventLog'
import StepLayout from '@/components/StepLayout'

function EditableName({ jobId, value, onSaved, onAction }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const name = draft.trim()
    if (!name || name === value) { setEditing(false); return }
    setSaving(true)
    try {
      const res = await api.post(`/api/job/${jobId}/rename`, { video_name: name })
      if (res?.error) throw new Error(res.error)
      onAction?.(`名称改成「${name}」`)
      setEditing(false)
      onSaved?.()
    } catch (e) {
      toast.error(`改名失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <button onClick={() => { setDraft(value); setEditing(true) }} className="group flex h-10 w-full items-center gap-2 rounded-lg border bg-card px-3 text-left text-sm">
        <span className="truncate">{value}</span>
        <Pencil className="ml-auto size-3.5 shrink-0 text-faint group-hover:text-foreground" />
      </button>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus value={draft} disabled={saving} className="h-10" aria-label="名称"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
      />
      <Button size="icon" variant="ghost" className="size-10 shrink-0" disabled={saving} onClick={save} aria-label="保存">
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button size="icon" variant="ghost" className="size-10 shrink-0" disabled={saving} onClick={() => setEditing(false)} aria-label="取消">
        <X className="size-4" />
      </Button>
    </div>
  )
}

function Segments({ states }) {
  return (
    <span className="flex gap-[3px]">
      {states.map((s, i) => (
        <span key={i} className={cn('h-1 w-9 rounded-full', s === 'done' ? 'bg-ink' : s === 'active' || s === 'error' ? 'bg-primary' : 'bg-border')} />
      ))}
    </span>
  )
}

function podcastProgress(status) {
  const s = status.podcast_state
  const clips = Object.keys(status.podcast_clips || {}).length
  if (!status.confirmed_transcript) return { states: ['pending', 'pending', 'pending', 'pending'], label: '字幕确认后可以开始' }
  if (!s && !clips) {
    const marked = status.podcast_markup_state === 'ready'
    return { states: [marked ? 'done' : 'active', 'pending', 'pending', 'pending'], label: '还没开始录' }
  }
  if (s === 'aligned') return { states: ['done', 'done', 'done', 'active'], label: '已对齐，可以导出' }
  if (s === 'aligning') return { states: ['done', 'done', 'active', 'pending'], label: '对齐中' }
  if (s === 'error') return { states: ['done', 'done', 'error', 'pending'], label: '出错' }
  return { states: ['done', 'active', 'pending', 'pending'], label: s ? PODCAST_LABELS[s] : `录音中 · 已录 ${clips} 句` }
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
      {label}
      <div className="text-sm text-foreground">{children}</div>
    </div>
  )
}

function LinkButton({ href, onClick, icon: Icon, label, hint }) {
  const cls = 'flex h-11 items-center gap-2.5 rounded-lg border bg-card px-3.5 text-sm hover:bg-paper'
  const inner = <><Icon className="size-4" />{label}<span className="ml-auto text-xs text-faint">{hint}</span></>
  if (!href && !onClick) return <div className={cn(cls, 'text-muted-foreground')}>{inner}</div>
  if (onClick) return <button onClick={onClick} className={cls}>{inner}</button>
  return <a href={href} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
}

export default function JobInfo({ jobId, status, onRefresh, onAction, onGo }) {
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showCalls, setShowCalls] = useState(false)
  const [showLog, setShowLog] = useState(false)

  const videoStates = STEPS.map((s) => stepState(status, s))
  const current = STEPS.find((s) => ['active', 'error'].includes(stepState(status, s)))
  const podcast = podcastProgress(status)

  const doDelete = async () => {
    await api.del(`/api/job/${jobId}`)
    toast.success('任务已删除')
    navigate('/')
  }

  return (
    <StepLayout className="flex gap-8">
      <div className="flex w-[400px] shrink-0 flex-col gap-3.5">
        {status.has_cover
          ? <img src={coverUrl(jobId, status)} alt="封面" className="aspect-video w-full rounded-xl object-cover" />
          : <video src={`${jobFileUrl(jobId, 'source.mp4')}#t=1`} preload="metadata" muted className="aspect-video w-full rounded-xl bg-black object-cover" />}
        <LinkButton icon={Maximize2} label="大屏播放" hint="边看边核对字幕" onClick={() => window.open(`/job/${jobId}/theater`, '_blank')} />
        <LinkButton icon={ExternalLink} label="博客文章" href={status.blog_url} hint={status.blog_url ? '' : status.blog_path ? '未发布' : '未生成'} />
        <LinkButton icon={ExternalLink} label="YouTube" href={status.youtube_url} hint={status.youtube_url ? '' : '未发布'} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <section className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border bg-card p-6">
          <Row label="名称"><EditableName jobId={jobId} value={status.video_name} onSaved={onRefresh} onAction={onAction} /></Row>
          <Row label="视频标题"><span className={cn(!status.selected_title && 'text-faint')}>{status.selected_title || '发布时再定'}</span></Row>
          <Row label="拍摄时间">{status.shot_at ? new Date(status.shot_at).toLocaleString() : '—'}</Row>
          <Row label="上传时间">{status.created_at ? new Date(status.created_at).toLocaleString() : '—'}</Row>
          <Row label="当前状态">{STAGE_LABELS[status.stage] || status.stage}</Row>
          <Row label="转录模型">Whisper {status.whisper_model || 'small'}</Row>
        </section>

        <section className="flex flex-col rounded-xl border bg-card">
          <div className="flex items-center gap-4 border-b border-border/60 px-6 py-4">
            <span className="w-16 text-[13px] text-muted-foreground">视频</span>
            <Segments states={videoStates} />
            <span className="text-sm">{status.stage === 'done' ? '已完成' : current ? `${current.label} · ${STAGE_LABELS[status.stage]}` : STAGE_LABELS[status.stage]}</span>
            {status.stage !== 'done' && current && (
              <button onClick={() => onGo(current.key)} className="ml-auto text-[13px] text-primary hover:underline">去处理 →</button>
            )}
          </div>
          <div className="flex items-center gap-4 px-6 py-4">
            <span className="w-16 text-[13px] text-muted-foreground">视频播客</span>
            <Segments states={podcast.states} />
            <span className="text-sm">{podcast.label}</span>
            {status.confirmed_transcript && (
              <button onClick={() => onGo('podcast')} className="ml-auto text-[13px] text-primary hover:underline">打开 →</button>
            )}
          </div>
        </section>

        {status.review_context && (
          <section className="flex flex-col gap-2 rounded-xl border bg-card px-6 py-5">
            <h2 className="text-[13px] font-medium text-muted-foreground">AI 摘要</h2>
            <p className="text-sm leading-relaxed">{status.review_context}</p>
            {status.review_points?.length > 0 && (
              <ul className="mt-1 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                {status.review_points.map((pt, i) => <li key={i}><span className="font-medium">{pt.title}</span>：{pt.body}</li>)}
              </ul>
            )}
          </section>
        )}

        <section className="flex flex-col rounded-xl border bg-card">
          {status.ai_call_count > 0 && (
            <div className="border-b border-border/60">
              <button onClick={() => setShowCalls((v) => !v)} className="flex w-full items-center px-6 py-4 text-sm">
                AI 调用记录<span className="ml-2 text-faint">{status.ai_call_count}</span>
                <span className="ml-auto text-[13px] text-primary">{showCalls ? '收起' : '展开'}</span>
              </button>
              {showCalls && <div className="px-6 pb-5"><AICallLog jobId={jobId} count={status.ai_call_count} liveCount={status.ai_live_count} /></div>}
            </div>
          )}
          {status.events?.length > 0 && (
            <div>
              <button onClick={() => setShowLog((v) => !v)} className="flex w-full items-center px-6 py-4 text-sm">
                处理日志<span className="ml-2 text-faint">{status.events.length}</span>
                <span className="ml-auto text-[13px] text-primary">{showLog ? '收起' : '展开'}</span>
              </button>
              {showLog && <div className="px-6 pb-5"><EventLog events={status.events} /></div>}
            </div>
          )}
        </section>

        <section className="flex items-center gap-4 rounded-xl border px-6 py-4">
          <div className="flex-1">
            <div className="text-sm font-medium">删除这个任务</div>
            <div className="mt-0.5 text-xs text-muted-foreground">只删本地文件，不影响已写入的博客和已发布的视频</div>
          </div>
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive" onClick={() => setConfirmDelete(true)}>删除</Button>
        </section>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这个任务？</DialogTitle>
            <DialogDescription>会删除本地中间文件（视频、字幕、封面等）。不会删除已经写入博客仓库的文章，也不会撤销已发布到 YouTube 的视频。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>取消</Button>
            <Button variant="destructive" onClick={doDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StepLayout>
  )
}
