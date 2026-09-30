import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, UploadCloud, ArrowDownUp, Trash2, Video, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, jobFileUrl } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { timeAgo, stageKind, formatDate, monthLabel, PODCAST_LABELS } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'review', label: '等我确认', alert: true },
  { key: 'processing', label: '处理中' },
  { key: 'error', label: '出错', alert: true },
  { key: 'done', label: '已完成' },
]

const KIND_PILL = {
  review: 'bg-primary-soft text-primary-soft-foreground',
  processing: 'bg-secondary text-foreground',
  error: 'bg-destructive/10 text-destructive',
  done: 'bg-success-soft text-success',
}

const SORTS = {
  updated: { label: '最近更新', key: (j) => j.updated_at || j.created_at || '' },
  shot: { label: '拍摄时间', key: (j) => j.shot_at || j.created_at || '' },
  created: { label: '上传时间', key: (j) => j.created_at || '' },
}

function podcastValue(job) {
  return job.podcast_state || 'none'
}

function youtubeValue(job) {
  if (job.youtube_url) return 'published'
  if (job.publish_state === 'uploading') return 'uploading'
  return 'none'
}

const PODCAST_OPTIONS = [['none', '未开始'], ...Object.entries(PODCAST_LABELS)]
const YOUTUBE_OPTIONS = [['published', '已发布'], ['uploading', '上传中'], ['none', '未发布']]
const BLOG_OPTIONS = [['yes', '有博客'], ['no', '没有博客']]

function FilterSelect({ label, value, onChange, options }) {
  const active = value !== 'all'
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn('bg-card text-[13px] data-[size=default]:h-10', active && 'border-foreground')}>
        <SelectValue placeholder={label}>
          {active ? `${label}：${options.find(([v]) => v === value)?.[1]}` : label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">全部</SelectItem>
        {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

const GRID = 'grid grid-cols-[28px_minmax(0,1fr)_88px_150px_96px_80px_84px] items-center gap-3'

function JobRow({ job, checked, onCheck }) {
  const kind = stageKind(job.stage)
  const pct = job.progress?.percent
  const podcast = job.podcast_state ? PODCAST_LABELS[job.podcast_state] : '—'
  const yt = youtubeValue(job)
  return (
    <div className={cn(GRID, 'group relative h-[60px] border-b border-border/60 px-4 hover:bg-paper', checked && 'bg-primary-soft/40')}>
      <input
        type="checkbox" checked={checked} onChange={(e) => onCheck(job.job_id, e.target.checked)}
        aria-label={`选择 ${job.selected_title || job.video_name}`}
        className="relative z-10 size-4 accent-primary"
      />
      <Link to={`/jobs/${job.job_id}`} className="flex min-w-0 items-center gap-3 after:absolute after:inset-0">
        <span
          className="flex h-9 w-16 shrink-0 items-center justify-center rounded-md bg-muted bg-cover bg-center"
          style={job.has_thumbnail ? { backgroundImage: `url(${jobFileUrl(job.job_id, 'thumbnail.jpg')})` } : undefined}
        >
          {!job.has_thumbnail && <Video className="size-4 text-faint" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{job.selected_title || job.video_name}</span>
          {job.selected_title && <span className="block truncate font-mono text-[11px] text-faint">{job.video_name}</span>}
        </span>
      </Link>
      <span className="text-[13px] text-muted-foreground">{formatDate(job.shot_at || job.created_at)}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium', KIND_PILL[kind])}>
          {job.stage_label}
        </span>
        {kind === 'processing' && pct != null && <Progress value={pct} className="h-1 w-10" />}
      </span>
      <span className={cn('text-[13px]', job.podcast_state ? 'text-foreground' : 'text-faint')}>{podcast}</span>
      <span className={cn('text-[13px]', yt === 'published' ? 'font-medium text-success' : yt === 'none' ? 'text-faint' : 'text-foreground')}>
        {yt === 'published' ? '已发布' : yt === 'uploading' ? '上传中' : '—'}
      </span>
      <span className="text-right text-xs text-faint">{timeAgo(job.updated_at || job.created_at)}</span>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [month, setMonth] = useState('all')
  const [podcast, setPodcast] = useState('all')
  const [youtube, setYoutube] = useState('all')
  const [blog, setBlog] = useState('all')
  const [sort, setSort] = useState('updated')
  const [checked, setChecked] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [uploadPct, setUploadPct] = useState(null)
  const [uploadName, setUploadName] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)

  const { data: jobs, refresh } = usePolling(() => api.get('/api/jobs'), { intervalMs: 4000 })

  const upload = useCallback((file) => {
    if (!file) return
    if (!file.type.startsWith('video/')) { toast.error('只能上传视频文件'); return }
    setUploadName(file.name)
    setUploadPct(0)
    const fd = new FormData()
    fd.append('video', file)
    api.upload('/upload', fd, setUploadPct).then((data) => {
      setUploadPct(null)
      if (data.error) { toast.error(data.error); return }
      navigate(`/jobs/${data.job_id}`)
    }).catch(() => { setUploadPct(null); toast.error('上传失败') })
  }, [navigate])

  const counts = useMemo(() => {
    const c = { all: jobs?.length || 0, review: 0, processing: 0, error: 0, done: 0 }
    jobs?.forEach((j) => { c[stageKind(j.stage)] += 1 })
    return c
  }, [jobs])

  const months = useMemo(() => {
    const seen = new Map()
    jobs?.forEach((j) => { const m = monthLabel(j.shot_at || j.created_at); seen.set(m, m) })
    return [...seen.entries()]
  }, [jobs])

  const filtered = useMemo(() => {
    if (!jobs) return []
    const q = query.trim().toLowerCase()
    const rows = jobs.filter((j) => (
      (tab === 'all' || stageKind(j.stage) === tab)
      && (!q || `${j.selected_title || ''} ${j.video_name || ''}`.toLowerCase().includes(q))
      && (month === 'all' || monthLabel(j.shot_at || j.created_at) === month)
      && (podcast === 'all' || podcastValue(j) === podcast)
      && (youtube === 'all' || youtubeValue(j) === youtube)
      && (blog === 'all' || (blog === 'yes') === !!j.has_blog)
    ))
    const key = SORTS[sort].key
    return rows.sort((a, b) => key(b).localeCompare(key(a)))
  }, [jobs, tab, query, month, podcast, youtube, blog, sort])

  // Grouped by shooting month so a long list stays scannable.
  const groups = useMemo(() => {
    const out = []
    filtered.forEach((j) => {
      const label = monthLabel(j.shot_at || j.created_at)
      let g = out.find((x) => x.label === label)
      if (!g) { g = { label, rows: [] }; out.push(g) }
      g.rows.push(j)
    })
    return out
  }, [filtered])

  const hasFilter = query || month !== 'all' || podcast !== 'all' || youtube !== 'all' || blog !== 'all'
  const clearFilters = () => { setQuery(''); setMonth('all'); setPodcast('all'); setYoutube('all'); setBlog('all') }

  const onCheck = useCallback((id, on) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id); else next.delete(id)
    return next
  }), [])
  const allChecked = filtered.length > 0 && filtered.every((j) => checked.has(j.job_id))
  const toggleAll = (on) => setChecked(on ? new Set(filtered.map((j) => j.job_id)) : new Set())

  const deleteChecked = async () => {
    const ids = [...checked]
    await Promise.all(ids.map((id) => api.del(`/api/job/${id}`)))
    toast.success(`已删除 ${ids.length} 个任务`)
    setChecked(new Set())
    setConfirmDelete(false)
    refresh()
  }

  return (
    <div
      className="relative mx-auto flex max-w-[1280px] flex-col gap-4 px-10 pt-7 pb-10"
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]) }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary-soft/80 text-lg font-medium text-primary-soft-foreground">
          松开就开始上传
        </div>
      )}

      <div className="flex items-center gap-3">
        <h1 className="text-[22px] font-bold">任务</h1>
        <span className="text-[13px] text-muted-foreground">共 {counts.all} 条</span>
        <div className="ml-auto flex items-center gap-3">
          {uploadPct !== null ? (
            <div className="w-48">
              <div className="mb-1 truncate text-xs text-muted-foreground">上传中 {uploadName} · {uploadPct}%</div>
              <Progress value={uploadPct} className="h-1" />
            </div>
          ) : (
            <span className="text-xs text-faint">也可以直接把视频拖进这个页面</span>
          )}
          <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
          <Button className="h-10 bg-ink px-4 text-background hover:bg-ink/90" onClick={() => fileInputRef.current?.click()}>
            <UploadCloud className="size-4" /> 上传视频
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="按状态筛选" className="flex gap-1 border-b">
        {TABS.map((t) => {
          const on = tab === t.key
          const n = counts[t.key]
          return (
            <button
              key={t.key} role="tab" aria-selected={on} onClick={() => setTab(t.key)}
              className={cn(
                '-mb-px flex h-11 items-center gap-1.5 border-b-2 px-3.5 text-sm transition-colors',
                on ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              <span className={cn('rounded-full px-1.5 text-xs leading-[18px]', t.alert && n > 0 ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}>{n}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-10 w-[340px] items-center gap-2 rounded-lg border border-[#CFC9BB] bg-card px-3 focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-4 text-muted-foreground" />
          <span className="sr-only">搜索任务</span>
          <input
            type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、文件名"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <FilterSelect label="拍摄时间" value={month} onChange={setMonth} options={months} />
        <FilterSelect label="视频播客" value={podcast} onChange={setPodcast} options={PODCAST_OPTIONS} />
        <FilterSelect label="YouTube" value={youtube} onChange={setYoutube} options={YOUTUBE_OPTIONS} />
        <FilterSelect label="博客" value={blog} onChange={setBlog} options={BLOG_OPTIONS} />
        {hasFilter && <button onClick={clearFilters} className="px-1.5 text-[13px] text-primary hover:underline">清除筛选</button>}
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="ml-auto border-0 bg-transparent text-[13px] text-muted-foreground shadow-none data-[size=default]:h-10">
            <ArrowDownUp className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {Object.entries(SORTS).map(([k, s]) => <SelectItem key={k} value={k}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className={cn(GRID, 'h-10 border-b px-4 text-xs text-muted-foreground')}>
          <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} aria-label="全选" className="size-4 accent-primary" />
          <span>视频</span><span>拍摄</span><span>制作</span><span>视频播客</span><span>YouTube</span><span className="text-right">更新</span>
        </div>
        {jobs && jobs.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">还没有任务，上传第一条视频试试</div>
        )}
        {jobs && jobs.length > 0 && filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            没有符合条件的任务{hasFilter && <>，<button onClick={clearFilters} className="text-primary hover:underline">清除筛选</button></>}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.label}>
            <h2 className="border-b border-border/60 bg-paper px-4 pt-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
              {g.label} · {g.rows.length} 条
            </h2>
            {g.rows.map((j) => <JobRow key={j.job_id} job={j} checked={checked.has(j.job_id)} onCheck={onCheck} />)}
          </section>
        ))}
      </div>

      {checked.size > 0 && (
        <div className="sticky bottom-6 z-20 mx-auto flex items-center gap-3 rounded-xl bg-ink px-4 py-2.5 text-sm text-background shadow-lg">
          已选 {checked.size} 条
          <Button size="sm" variant="ghost" className="text-background hover:bg-background/10 hover:text-background" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" /> 删除
          </Button>
          <button onClick={() => setChecked(new Set())} aria-label="取消选择" className="rounded p-1 hover:bg-background/10"><X className="size-4" /></button>
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这 {checked.size} 个任务？</DialogTitle>
            <DialogDescription>
              会删除本地中间文件（视频、字幕、封面等）。不会删除已经写入博客仓库的文章，也不会撤销已发布到 YouTube 的视频。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>取消</Button>
            <Button variant="destructive" onClick={deleteChecked}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
