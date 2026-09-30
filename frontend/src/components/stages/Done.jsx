import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, jobFileUrl } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { loadPublishDefaults } from '@/lib/publishDefaults'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import StepLayout from '@/components/StepLayout'

const FILES = [
  ['final.mp4', '成片 · 带字幕'],
  ['thumbnail.jpg', '封面 1280×720'],
  ['transcript.srt', '字幕文件'],
]

const PRIVACY = [['private', '私享'], ['unlisted', '不公开'], ['public', '公开']]

function PublishForm({ jobId, status, yt, onAdvance, onAction }) {
  const defaults = loadPublishDefaults()
  const suggestions = status.creative?.titles || []
  const [title, setTitle] = useState(status.selected_title || suggestions[0] || '')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState(defaults.tags)
  const [privacy, setPrivacy] = useState(defaults.privacy)

  const publish = () => {
    if (!title.trim()) { toast.error('先填标题'); return }
    if (privacy === 'public' && !confirm('确定直接公开发布？建议先用「私享」检查一遍。')) return
    onAction?.(`发布到 YouTube（${PRIVACY.find(([v]) => v === privacy)[1]}）`)
    api.post(`/api/job/${jobId}/publish_youtube`, { title, description, tags, privacy_status: privacy }).then(onAdvance)
  }

  return (
    <div className="flex flex-col gap-4">
      {status.publish_state === 'error' && <p className="text-xs text-destructive">上次发布失败：{status.publish_error}</p>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="yt-title" className="text-[13px] font-normal">标题</Label>
        <Input id="yt-title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-11" />
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {suggestions.map((t) => (
              <button
                key={t} onClick={() => setTitle(t)}
                className={cn('max-w-full truncate rounded-full border px-2.5 py-1 text-xs', t === title ? 'border-foreground bg-secondary' : 'bg-card hover:bg-secondary')}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="yt-desc" className="text-[13px] font-normal">简介</Label>
        <Textarea id="yt-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="h-24 resize-none" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="yt-tags" className="text-[13px] font-normal">标签（逗号分隔）</Label>
        <Input id="yt-tags" value={tags} onChange={(e) => setTags(e.target.value)} className="h-11" />
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[13px]">可见性</legend>
        <div className="flex gap-2">
          {PRIVACY.map(([v, l]) => (
            <label
              key={v}
              className={cn('flex h-10 flex-1 cursor-pointer items-center justify-center rounded-lg border text-[13px] has-focus-visible:ring-2 has-focus-visible:ring-ring/50', privacy === v ? 'border-ink bg-ink text-background' : 'bg-card')}
            >
              <input type="radio" name="privacy" value={v} checked={privacy === v} onChange={() => setPrivacy(v)} className="sr-only" />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      <Button className="h-12 text-[15px]" onClick={publish}>上传到 {yt.channel?.title || 'YouTube'}</Button>
      <p className="text-xs text-muted-foreground">发布后会自动把视频链接写回博客文章</p>
    </div>
  )
}

function PublishPanel({ jobId, status, onAdvance, onAction }) {
  const { data: yt } = usePolling(() => api.get('/api/youtube/status'), { intervalMs: 5000 })

  let body
  if (status.publish_state === 'uploading') {
    body = (
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 正在上传… {status.publish_progress || 0}%
        </div>
        <Progress value={status.publish_progress || 0} />
      </div>
    )
  } else if (status.publish_state === 'success') {
    body = (
      <p className="text-sm">
        已发布：<a href={status.youtube_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{status.youtube_url}</a>
      </p>
    )
  } else if (!yt) {
    body = <Loader2 className="size-4 animate-spin text-muted-foreground" />
  } else if (!yt.configured || !yt.connected) {
    body = (
      <p className="text-sm text-muted-foreground">
        {!yt.configured ? '还没配置 YouTube。' : '还没连接频道。'}去 <Link to="/settings" className="text-primary hover:underline">设置页</Link> 弄好后就能直接发布。
      </p>
    )
  } else {
    body = <PublishForm jobId={jobId} status={status} yt={yt} onAdvance={onAdvance} onAction={onAction} />
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4 self-start rounded-xl border bg-card p-7">
      <div className="flex items-center">
        <h2 className="text-[17px] font-bold">发布到 YouTube</h2>
        <span className="ml-auto text-xs text-muted-foreground">可选</span>
      </div>
      {body}
    </section>
  )
}

export default function Done({ jobId, status, onAdvance, onAction }) {
  return (
    <StepLayout className="flex gap-10">
      <div className="flex w-[480px] shrink-0 flex-col gap-5">
        <video controls src={jobFileUrl(jobId, 'final.mp4')} className="aspect-video w-full rounded-xl bg-black" />
        <div className="flex flex-col rounded-xl border bg-card">
          {FILES.map(([name, desc], i) => (
            <a
              key={name} href={jobFileUrl(jobId, name)} download
              className={cn('flex items-center gap-3.5 px-4.5 py-3.5 text-sm hover:bg-paper', i < FILES.length - 1 && 'border-b border-border/60')}
            >
              <span className="font-mono text-[13px]">{name}</span>
              <span className="text-xs text-muted-foreground">{desc}</span>
              <span className="ml-auto flex items-center gap-1 text-[13px] text-primary"><Download className="size-3.5" />下载</span>
            </a>
          ))}
        </div>
      </div>
      <PublishPanel jobId={jobId} status={status} onAdvance={onAdvance} onAction={onAction} />
    </StepLayout>
  )
}
