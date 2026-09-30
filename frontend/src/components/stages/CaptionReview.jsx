import { useEffect, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, jobFileUrl, coverUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import StepLayout from '@/components/StepLayout'

function Field({ id, label, value, onChange }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-normal text-muted-foreground">{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-10 bg-card" />
    </div>
  )
}

// The YouTube cover: pick a candidate frame, edit the overlay copy, re-render.
function CoverEditor({ jobId, status, onAction }) {
  const saved = status.platforms?.youtube || {}
  const initial = saved.cover || status.creative?.thumbnail || {}
  const frames = status.candidate_frames || []

  const [frame, setFrame] = useState(saved.frame || status.selected_frame || frames[0])
  const [tag, setTag] = useState(initial.tag || '')
  const [line1, setLine1] = useState(initial.title_line1 || '')
  const [line2, setLine2] = useState(initial.title_line2 || '')
  const [subtitle, setSubtitle] = useState(initial.subtitle || '')
  const [previewUrl, setPreviewUrl] = useState(status.has_cover ? coverUrl(jobId, status) : null)
  const [rendering, setRendering] = useState(false)

  const render = (overrides = {}, action) => {
    setRendering(true)
    api.post(`/api/job/${jobId}/platform/youtube/cover`, {
      frame, tag, title_line1: line1, title_line2: line2, subtitle, ...overrides,
    })
      .then((d) => {
        if (d?.error) throw new Error(d.error)
        setPreviewUrl(d.cover_url)
        if (action) onAction?.(action)
      })
      .catch((e) => toast.error(`封面生成失败：${e.message}`))
      .finally(() => setRendering(false))
  }

  useEffect(() => { if (!previewUrl && frames.length) render() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!frames.length) return <p className="text-sm text-muted-foreground">没有封面候选帧。</p>

  return (
    <div className="flex gap-8">
      <div className="flex w-[560px] shrink-0 flex-col gap-3">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted">
          {previewUrl && <img src={previewUrl} alt="封面预览" className="size-full object-cover" />}
          {rendering && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/30">
              <Loader2 className="size-6 animate-spin text-background" />
            </div>
          )}
        </div>
        <div className="text-xs text-muted-foreground">从视频里抽出的候选帧，点一张换封面</div>
        <div className="grid grid-cols-6 gap-2">
          {frames.map((name, i) => (
            <button
              key={name}
              aria-label={`候选帧 ${i + 1}`}
              aria-pressed={frame === name}
              onClick={() => { setFrame(name); render({ frame: name }, `封面换成第 ${i + 1} 帧`) }}
              className={cn('overflow-hidden rounded-lg', frame === name && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}
            >
              <img src={jobFileUrl(jobId, `frames/${name}`)} alt="" className="aspect-video w-full object-cover" />
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">封面文案</h3>
        <Field id="cover-tag" label="地点标签" value={tag} onChange={setTag} />
        <Field id="cover-line1" label="大字第一行" value={line1} onChange={setLine1} />
        <Field id="cover-line2" label="大字第二行" value={line2} onChange={setLine2} />
        <Field id="cover-sub" label="副标题" value={subtitle} onChange={setSubtitle} />
        <div className="flex gap-2">
          <Button variant="outline" disabled={rendering} onClick={() => render({}, '更新了封面文案')}>
            {rendering ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 更新封面
          </Button>
          {previewUrl && (
            <Button variant="ghost" asChild>
              <a href={jobFileUrl(jobId, 'thumbnail.jpg')} download><Download className="size-4" /> 下载</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function CaptionStyle({ jobId, status, fontsize, setFontsize, onRecaption, recap }) {
  return (
    <section className="flex gap-8 border-t pt-7">
      <video
        controls src={`${jobFileUrl(jobId, 'preview.mp4')}?v=${status.fontsize || ''}`}
        className="aspect-video w-[560px] shrink-0 rounded-xl bg-black"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">视频字幕</h3>
        {recap ? (
          <p className="text-sm">字号 {status.fontsize}</p>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <Label htmlFor="fontsize" className="w-9 text-[13px] font-normal">字号</Label>
              <Slider id="fontsize" min={60} max={180} step={2} value={[fontsize]} onValueChange={([v]) => setFontsize(v)} className="flex-1" />
              <span className="w-9 text-right font-mono text-[13px]">{fontsize}</span>
            </div>
            <Button variant="outline" className="self-start" disabled={fontsize === status.fontsize} onClick={onRecaption}>
              用这个字号重新预览
            </Button>
          </>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">左边是前 50 秒的效果：白字黑边，AI 挑的关键词会高亮成黄色。</p>
      </div>
    </section>
  )
}

export default function CaptionReview({ jobId, status, onAdvance, onAction, recap = false }) {
  const [fontsize, setFontsize] = useState(status.fontsize || 130)
  const [busy, setBusy] = useState(false)

  const recaption = () => {
    setBusy(true)
    onAction?.(`字幕字号改成 ${fontsize}，重新预览`)
    api.post(`/api/job/${jobId}/recaption`, { fontsize }).then(onAdvance).finally(() => setBusy(false))
  }
  const confirm = () => {
    setBusy(true)
    onAction?.('确认封面和字幕样式，开始导出成片')
    api.post(`/api/job/${jobId}/confirm_captions`).then(onAdvance).finally(() => setBusy(false))
  }

  return (
    <StepLayout
      className="flex flex-col gap-7"
      footer={!recap && <Button className="h-11 px-5" disabled={busy} onClick={confirm}>导出成片</Button>}
    >
      <CoverEditor jobId={jobId} status={status} onAction={onAction} />
      <CaptionStyle
        jobId={jobId} status={status} fontsize={fontsize} setFontsize={setFontsize}
        onRecaption={recaption} recap={recap}
      />
    </StepLayout>
  )
}
