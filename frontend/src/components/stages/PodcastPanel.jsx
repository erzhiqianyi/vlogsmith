import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, jobFileUrl } from '@/lib/api'
import { formatTime, srtTimeToSeconds } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Mic, Square, Upload, Loader2, Sparkles, RefreshCw, Check, Trash2, Combine } from 'lucide-react'
import { Progress } from '@/components/ui/progress'

// Phase 1: re-record the cleaned script — either line by line (clips merged
// server-side with exact timings) or in one take (uploaded, then force-aligned
// with speech recognition) — so we know when each line is spoken. The karaoke-style video export (furigana + highlight + cover
// background) is a separate next step built on top of this timed line list.
function readProgressKey(jobId) { return `podcastReadIndex:${jobId}` }

// Splits a line's plain text into segments around its ruby/highlight substrings
// (found by simple indexOf against the original text — the AI is asked to only
// ever return exact substrings, so this stays a plain string operation).
function buildSegments(text, markup) {
  if (!markup) return [{ text }]
  const matches = []
  ;(markup.ruby || []).forEach(({ word, reading }) => {
    const i = word ? text.indexOf(word) : -1
    if (i !== -1) matches.push({ start: i, end: i + word.length, text: word, ruby: reading })
  })
  ;(markup.highlights || []).forEach((word) => {
    const i = word ? text.indexOf(word) : -1
    if (i === -1) return
    const overlap = matches.find((m) => i < m.end && i + word.length > m.start)
    if (overlap) { overlap.highlight = true; return }
    matches.push({ start: i, end: i + word.length, text: word, highlight: true })
  })
  matches.sort((a, b) => a.start - b.start)
  const segments = []
  let cursor = 0
  for (const m of matches) {
    if (m.start < cursor) continue
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) })
    segments.push(m)
    cursor = m.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}

function MarkupText({ text, markup }) {
  const segments = useMemo(() => buildSegments(text, markup), [text, markup])
  return segments.map((s, i) => {
    const inner = s.ruby ? <ruby>{s.text}<rt className="text-[10px] text-muted-foreground">{s.ruby}</rt></ruby> : s.text
    if (!s.highlight) return <span key={i}>{inner}</span>
    return <span key={i} className="rounded-sm bg-amber-200/60 px-0.5 font-semibold text-amber-900 dark:bg-amber-500/20 dark:text-amber-300">{inner}</span>
  })
}

// Word-type colors for the tokenized script (same idea as karaoke lyric apps:
// a colored bar under each word, furigana above, the line's translation below).
const POS = {
  noun: { label: '名词', bar: 'border-amber-400' },
  proper: { label: '专有名词', bar: 'border-orange-500' },
  pronoun: { label: '代词', bar: 'border-yellow-300' },
  number: { label: '数词', bar: 'border-lime-500' },
  verb: { label: '动词', bar: 'border-sky-500' },
  adj: { label: '形容词', bar: 'border-violet-400' },
  adv: { label: '副词', bar: 'border-emerald-500' },
  particle: { label: '助词', bar: 'border-teal-400' },
  aux: { label: '助动词', bar: 'border-pink-400' },
  conj: { label: '接续词', bar: 'border-slate-400' },
  interj: { label: '感叹词', bar: 'border-rose-400' },
  prefix: { label: '接头/接尾', bar: 'border-stone-400' },
}
const HAS_KANJI = /[\u3400-\u9fff々]/

function isTokenMarkup(markup) {
  return !!markup && Object.values(markup).some((m) => m?.t || m?.drop)
}

function PosLegend() {
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {Object.values(POS).map((p) => (
        <span key={p.label} className="flex items-center gap-1">
          <span className={cn('inline-block h-0 w-3 border-b-[3px]', p.bar)} />{p.label}
        </span>
      ))}
    </div>
  )
}

function TokenLine({ tokens, zh }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-end gap-x-1.5 gap-y-1.5">
        {tokens.map(([word, reading, pos], i) => {
          if (pos === 'punct') return <span key={i} className="pb-1 text-[17px] font-semibold">{word}</span>
          const style = POS[pos] || POS.noun
          return (
            <span key={i} className="inline-flex flex-col items-center leading-none" title={style.label}>
              <span className="mb-0.5 h-3.5 text-[11px] text-muted-foreground">{HAS_KANJI.test(word) ? reading : ''}</span>
              <span className={cn('border-b-[3px] px-0.5 pb-0.5 text-[17px] font-semibold', style.bar)}>{word}</span>
            </span>
          )
        })}
      </div>
      {zh && <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{zh}</p>}
    </div>
  )
}

function ScriptLine({ text, markup }) {
  if (markup?.t) return <TokenLine tokens={markup.t} zh={markup.zh} />
  return <MarkupText text={text} markup={markup} />
}

// Pause length between this line and the previous one, from the original
// (already-confirmed) timestamps — a stand-in for the podcast's actual rhythm
// until there's a real recording to measure against.
function pauseClass(prevEndSec, startSec) {
  if (prevEndSec == null) return ''
  const gap = startSec - prevEndSec
  if (gap > 1.2) return 'mt-4 border-t border-dashed pt-2'
  if (gap < 0.15) return '-mt-1'
  return ''
}

const MODE_KEY = 'podcastRecordMode'

function plainText(entry, markup) {
  const m = markup?.[String(entry.index)]
  return m?.t ? m.t.map((t) => t[0]).join('') : entry.text
}

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export default function PodcastPanel({ jobId, status, onRefresh }) {
  const [mode, setModeState] = useState(() => {
    try { return localStorage.getItem(MODE_KEY) || 'line' } catch { return 'line' }
  })
  // null | 'whole' | <line index>
  const [recording, setRecording] = useState(null)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(null)
  const [selectedIndex, setSelectedIndex] = useState(null)
  const [scriptEntries, setScriptEntries] = useState(null)
  const [markup, setMarkup] = useState(null)
  const [markupBusy, setMarkupBusy] = useState(false)
  const [clips, setClips] = useState(status.podcast_clips || {})
  const [readIndex, setReadIndex] = useState(() => {
    try {
      const v = localStorage.getItem(readProgressKey(jobId))
      return v ? Number(v) : null
    } catch { return null }
  })

  const streamRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const audioRef = useRef(null)
  const fileInputRef = useRef(null)
  const rowRefs = useRef({})

  const podcastState = status.podcast_state || 'none'
  const busy = podcastState === 'aligning' || podcastState === 'merging'
  const lineTimes = useMemo(() => Object.fromEntries((status.podcast_lines || []).map((l) => [l.index, l])), [status.podcast_lines])

  useEffect(() => { setClips(status.podcast_clips || {}) }, [status.podcast_clips])

  useEffect(() => {
    api.get(`/api/job/${jobId}/transcript_text`).then((d) => setScriptEntries(d.entries || []))
  }, [jobId])

  const markupState = status.podcast_markup_state
  useEffect(() => {
    setMarkupBusy(markupState === 'generating')
    if (markupState !== 'ready') return
    fetch(jobFileUrl(jobId, 'podcast/markup.json')).then((r) => (r.ok ? r.json() : null)).then(setMarkup).catch(() => {})
  }, [jobId, markupState])

  // The job may already have a markup.json on disk from before podcast_markup_state
  // was wired up — try loading it once regardless of status, quietly ignoring a 404.
  useEffect(() => {
    fetch(jobFileUrl(jobId, 'podcast/markup.json')).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setMarkup(d) }).catch(() => {})
  }, [jobId])

  const richMarkup = isTokenMarkup(markup)
  const visibleEntries = useMemo(
    () => (scriptEntries && richMarkup ? scriptEntries.filter((e) => !markup[String(e.index)]?.drop) : scriptEntries),
    [scriptEntries, markup, richMarkup],
  )
  const droppedCount = scriptEntries && visibleEntries ? scriptEntries.length - visibleEntries.length : 0
  const recordedCount = visibleEntries ? visibleEntries.filter((e) => clips[String(e.index)]).length : 0

  useEffect(() => {
    if (selectedIndex == null && visibleEntries?.length) {
      setSelectedIndex((visibleEntries.find((e) => !clips[String(e.index)]) || visibleEntries[0]).index)
    }
  }, [visibleEntries, clips, selectedIndex])

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])
  useEffect(() => () => { clearInterval(timerRef.current); releaseStream() }, [releaseStream])

  const setMode = (m) => {
    if (recording != null) return
    setModeState(m)
    if (m === 'whole') releaseStream()
    try { localStorage.setItem(MODE_KEY, m) } catch { /* empty */ }
  }

  const generateMarkup = () => {
    if (richMarkup && !confirm('重新生成会覆盖现在的分词和翻译，确定吗？')) return
    setMarkupBusy(true)
    api.post(`/api/job/${jobId}/podcast/markup`).then(() => { onRefresh() }).catch(() => { setMarkupBusy(false); toast.error('请求失败') })
  }

  const uploadWhole = useCallback((blob, filename) => {
    setUploading(true)
    const fd = new FormData()
    fd.append('audio', blob, filename)
    api.upload(`/api/job/${jobId}/podcast/upload`, fd).then((data) => {
      setUploading(false)
      if (data.error) { toast.error(data.error); return }
      toast.success('录音已保存')
      onRefresh()
    }).catch(() => { setUploading(false); toast.error('上传失败') })
  }, [jobId, onRefresh])

  const nextEntryAfter = useCallback((index) => {
    const i = visibleEntries?.findIndex((e) => e.index === index) ?? -1
    return i >= 0 ? visibleEntries[i + 1] : null
  }, [visibleEntries])

  const uploadClip = useCallback((index, blob) => {
    const fd = new FormData()
    fd.append('audio', blob, 'clip.webm')
    api.upload(`/api/job/${jobId}/podcast/clip/${index}`, fd).then((data) => {
      if (data.error) { toast.error(data.error); return }
      setClips(data.clips)
    }).catch(() => toast.error(`第 ${index} 句上传失败`))
  }, [jobId])

  const deleteClip = (index) => {
    api.del(`/api/job/${jobId}/podcast/clip/${index}`).then((data) => data?.clips && setClips(data.clips))
  }

  const startRecording = useCallback(async (target) => {
    try {
      if (!streamRef.current) streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(streamRef.current)
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        clearInterval(timerRef.current)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (target === 'whole') {
          releaseStream()
          uploadWhole(blob, 'recording.webm')
        } else {
          uploadClip(target, blob)
        }
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(target)
      setRecordSeconds(0)
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    } catch {
      toast.error('无法访问麦克风，检查浏览器权限')
    }
  }, [releaseStream, uploadWhole, uploadClip])

  const stopRecording = useCallback(() => {
    const target = recording
    mediaRecorderRef.current?.stop()
    setRecording(null)
    if (typeof target === 'number') {
      const next = nextEntryAfter(target)
      if (next) setSelectedIndex(next.index)
    }
  }, [recording, nextEntryAfter])

  const toggleLineRecording = useCallback(() => {
    if (recording != null) stopRecording()
    else if (selectedIndex != null) startRecording(selectedIndex)
  }, [recording, selectedIndex, startRecording, stopRecording])

  // Line mode shortcuts: Space starts/stops the selected line, ↑/↓ moves between lines.
  useEffect(() => {
    if (mode !== 'line') return
    const onKey = (e) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space') { e.preventDefault(); toggleLineRecording(); return }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && recording == null && visibleEntries) {
        e.preventDefault()
        const i = visibleEntries.findIndex((v) => v.index === selectedIndex)
        const j = Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), visibleEntries.length - 1)
        setSelectedIndex(visibleEntries[j].index)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, toggleLineRecording, recording, visibleEntries, selectedIndex])

  useEffect(() => {
    const target = mode === 'line' ? selectedIndex : activeIndex
    rowRefs.current[target]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [mode, selectedIndex, activeIndex])

  const onFileChosen = (e) => {
    const file = e.target.files?.[0]
    if (file) uploadWhole(file, file.name)
    e.target.value = ''
  }

  const align = () => api.post(`/api/job/${jobId}/podcast/align`).then(onRefresh)
  const merge = () => api.post(`/api/job/${jobId}/podcast/merge`).then(onRefresh)

  const setRead = useCallback((v) => {
    setReadIndex(v)
    try {
      if (v == null) localStorage.removeItem(readProgressKey(jobId))
      else localStorage.setItem(readProgressKey(jobId), String(v))
    } catch { /* empty */ }
  }, [jobId])

  const toggleRead = useCallback((index) => {
    if (!visibleEntries) return
    if (readIndex != null && index <= readIndex) {
      const i = visibleEntries.findIndex((e) => e.index === index)
      setRead(i > 0 ? visibleEntries[i - 1].index : null)
    } else {
      setRead(index)
    }
  }, [visibleEntries, readIndex, setRead])

  const lines = status.podcast_lines
  useEffect(() => {
    const el = audioRef.current
    if (!el || !lines?.length) return
    const onTime = () => {
      const t = el.currentTime
      const active = [...lines].reverse().find((l) => t >= l.start)
      setActiveIndex(active ? active.index : null)
    }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [lines, status.podcast_audio])

  const seek = (sec) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = sec
    audioRef.current.play()
  }

  const selectedEntry = visibleEntries?.find((e) => e.index === selectedIndex)
  const selectedPos = visibleEntries ? visibleEntries.findIndex((e) => e.index === selectedIndex) + 1 : 0
  const selectedClip = selectedIndex != null ? clips[String(selectedIndex)] : null

  return (
    <div className="flex items-start gap-6">
      {/* ---- Script ---- */}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">视频播客稿</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {mode === 'line' ? '点一句选中，在右边录这一句；录完自动跳到下一句' : '照着念，勾选标记念到哪一句了；虚线是长停顿'}
              {droppedCount > 0 && <span className="ml-1.5">· 已去掉 {droppedCount} 条重复</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {mode === 'whole' && readIndex != null && (
              <button onClick={() => setRead(null)} className="text-xs text-muted-foreground underline">重置进度</button>
            )}
            <button onClick={generateMarkup} disabled={markupBusy} className="flex items-center gap-1 text-xs text-primary hover:underline disabled:text-muted-foreground">
              {markupBusy ? <Loader2 className="size-3 animate-spin" /> : richMarkup ? <RefreshCw className="size-3" /> : <Sparkles className="size-3" />}
              {markupBusy ? '正在去重、分词、注音和翻译...' : richMarkup ? '重新生成' : '去重 · 分词 · 注音 · 中文翻译'}
            </button>
          </div>
        </div>
        {markupState === 'error' && !markupBusy && (
          <p className="mb-2 text-xs text-destructive">生成失败，可以再试一次。{status.podcast_markup_error?.trim().split('\n').pop()}</p>
        )}
        {richMarkup && <PosLegend />}

        {visibleEntries === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="max-h-[calc(100vh-240px)] min-h-[360px] overflow-y-auto rounded-md border bg-muted/30 p-1">
            {visibleEntries.map((e, i) => {
              const key = String(e.index)
              const isRead = mode === 'whole' && readIndex != null && e.index <= readIndex
              const isNext = mode === 'whole' && (readIndex != null ? e.index === visibleEntries.find((v) => v.index > readIndex)?.index : i === 0)
              const isSelected = mode === 'line' && e.index === selectedIndex
              const isRecordingThis = recording === e.index
              const prev = visibleEntries[i - 1]
              const gapClass = prev ? pauseClass(srtTimeToSeconds(prev.end), srtTimeToSeconds(e.start)) : ''
              const time = lineTimes[e.index]
              return (
                <div
                  key={e.index}
                  ref={(el) => { rowRefs.current[e.index] = el }}
                  onClick={() => mode === 'line' && recording == null && setSelectedIndex(e.index)}
                  className={cn(
                    'flex items-start gap-3 rounded-md px-3 py-2.5 text-[15px] leading-relaxed odd:bg-background/60',
                    mode === 'line' && 'cursor-pointer hover:bg-accent/60',
                    (isNext || isSelected) && 'bg-primary/10 ring-1 ring-primary/30 odd:bg-primary/10',
                    isRecordingThis && 'bg-red-500/10 ring-red-500/40 odd:bg-red-500/10',
                    activeIndex === e.index && 'bg-amber-400/15 odd:bg-amber-400/15',
                    gapClass,
                  )}
                >
                  {mode === 'whole' ? (
                    <input
                      type="checkbox"
                      checked={isRead}
                      onChange={() => toggleRead(e.index)}
                      className="mt-1.5 size-3.5 shrink-0 accent-primary"
                      title="标记已经念到这一句"
                    />
                  ) : (
                    <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
                      {isRecordingThis
                        ? <span className="size-2.5 animate-pulse rounded-full bg-red-500" />
                        : clips[key]
                          ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                          : <span className="size-2 rounded-full border border-muted-foreground/40" />}
                    </span>
                  )}
                  <span className="w-6 shrink-0 pt-0.5 text-xs text-muted-foreground/70">
                    {e.index}
                    {time && (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); seek(time.start) }}
                        className="block text-[10px] text-primary hover:underline"
                        title="从这里播放"
                      >
                        {formatTime(time.start)}
                      </button>
                    )}
                  </span>
                  <div className={cn('min-w-0', isRead && 'opacity-40')}>
                    <ScriptLine text={e.text} markup={markup?.[key]} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ---- Recorder ---- */}
      <aside className="sticky top-[96px] w-[300px] shrink-0 space-y-4">
        <div className="rounded-lg border p-4">
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
            {[['line', '逐句录'], ['whole', '整段录']].map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={recording != null}
                className={cn('rounded py-1.5 font-medium text-muted-foreground', mode === m && 'bg-background text-foreground shadow-sm')}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'line' ? (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-xs text-muted-foreground">
                <span>第 {selectedPos} / {visibleEntries?.length || 0} 句</span>
                <span>已录 {recordedCount} 句</span>
              </div>
              <Progress value={visibleEntries?.length ? (recordedCount / visibleEntries.length) * 100 : 0} />

              <p className="mt-3 min-h-[3.5em] rounded-md bg-muted/50 p-2.5 text-sm leading-relaxed">
                {selectedEntry ? plainText(selectedEntry, markup) : '在左边选一句'}
              </p>

              {recording != null ? (
                <Button variant="destructive" className="mt-3 w-full" onClick={stopRecording}>
                  <Square className="size-4" /> 停止（{formatTime(recordSeconds)}）
                </Button>
              ) : (
                <Button className="mt-3 w-full" onClick={toggleLineRecording} disabled={!selectedEntry || busy}>
                  <Mic className="size-4" /> {selectedClip ? '重录这一句' : '录这一句'}
                </Button>
              )}
              <p className="mt-1.5 text-center text-[11px] text-muted-foreground">空格 开始/停止 · ↑↓ 切换句子</p>

              {selectedClip && recording == null && (
                <div className="mt-3 flex items-center gap-2">
                  <audio controls src={jobFileUrl(jobId, `podcast/clips/${selectedClip}`)} className="h-8 min-w-0 flex-1" />
                  <button onClick={() => deleteClip(selectedIndex)} className="shrink-0 text-muted-foreground hover:text-destructive" title="删除这句录音">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )}

              <Button variant="outline" className="mt-4 w-full" onClick={merge} disabled={!recordedCount || busy || recording != null}>
                {podcastState === 'merging' ? <Loader2 className="size-4 animate-spin" /> : <Combine className="size-4" />}
                {podcastState === 'merging' ? '正在合并...' : '合并成完整录音'}
              </Button>
              {recordedCount > 0 && recordedCount < (visibleEntries?.length || 0) && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">还有 {visibleEntries.length - recordedCount} 句没录，合并时会跳过</p>
              )}
            </div>
          ) : (
            <div>
              <p className="mb-3 text-xs text-muted-foreground">
                从头到尾一口气录完（念错了接着说就行），录完用语音识别对齐每一句的时间。
              </p>
              {recording === 'whole' ? (
                <Button variant="destructive" className="w-full" onClick={stopRecording}>
                  <Square className="size-4" /> 停止录音（{formatTime(recordSeconds)}）
                </Button>
              ) : (
                <Button className="w-full" onClick={() => startRecording('whole')} disabled={uploading || busy}>
                  <Mic className="size-4" /> {status.podcast_audio ? '重新录音' : '开始录音'}
                </Button>
              )}
              <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={onFileChosen} />
              <Button variant="outline" className="mt-2 w-full" onClick={() => fileInputRef.current?.click()} disabled={recording != null || uploading || busy}>
                <Upload className="size-4" /> 上传已录好的音频
              </Button>
              {uploading && (
                <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 正在保存录音...
                </p>
              )}
              {status.podcast_audio && (
                <Button variant="outline" className="mt-2 w-full" onClick={align} disabled={busy || recording != null}>
                  {podcastState === 'aligning' && <Loader2 className="size-4 animate-spin" />}
                  {podcastState === 'aligning' ? '正在对齐...' : podcastState === 'aligned' ? '重新对齐时间轴' : '对齐时间轴'}
                </Button>
              )}
            </div>
          )}
        </div>

        {status.podcast_audio && podcastState !== 'none' && (
          <div className="rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              完整录音
              <span className="text-xs font-normal text-muted-foreground">
                {podcastState === 'aligned' ? `已对齐 ${lines?.length || 0} 句` : podcastState === 'recorded' ? '未对齐' : ''}
              </span>
            </div>
            <audio ref={audioRef} controls src={`${jobFileUrl(jobId, `podcast/${status.podcast_audio}`)}?_=${status.updated_at}`} className="w-full" />
            {podcastState === 'aligned' && <p className="mt-1.5 text-[11px] text-muted-foreground">点左边句子下面的时间可以跳到那一句</p>}
          </div>
        )}

        {podcastState === 'error' && (
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md bg-destructive/5 p-3 text-xs text-destructive">
            {status.podcast_error}
          </pre>
        )}
      </aside>
    </div>
  )
}
