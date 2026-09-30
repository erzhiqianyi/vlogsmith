import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, X } from 'lucide-react'
import { api, jobFileUrl } from '@/lib/api'
import { formatTime, srtTimeToSeconds } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChatBridgeContext } from '@/lib/chat'
import StepLayout from '@/components/StepLayout'

function dismissedKey(jobId) { return `dismissedNote:${jobId}` }

// A suggested fix is shown as a diff until the user takes or drops it; after that
// the row is a plain editable line.
const EntryRow = memo(function EntryRow({
  entry, correction, decision, isActive, selected,
  onToggleSelect, onSeek, onDecide, registerInput, onTextChange,
}) {
  const pending = correction && !decision
  const value = correction && decision === 'accepted' ? correction.fixed : entry.text
  return (
    <div
      id={`row-${entry.index}`}
      className={cn(
        'flex gap-3 border-b border-border/60 px-4 py-2.5',
        pending && 'bg-primary-soft/40',
        isActive && 'bg-paper shadow-[inset_3px_0_0_var(--ink)]',
      )}
    >
      <input
        type="checkbox" checked={selected} onChange={(e) => onToggleSelect(entry.index, e.target.checked)}
        aria-label={`选中第 ${entry.index} 行，发给 AI`}
        className="mt-2 size-3.5 shrink-0 accent-primary"
      />
      <button
        onClick={() => onSeek(entry.startSec)}
        className={cn('mt-1.5 w-11 shrink-0 text-left font-mono text-xs hover:text-primary', isActive ? 'text-foreground' : 'text-faint')}
        title="从这里播放"
      >
        {formatTime(entry.startSec)}
      </button>
      {pending ? (
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
          <div className="text-[15px] leading-relaxed">
            <span className="text-faint line-through">{correction.original || entry.text}</span>
            <span className="mx-1.5 text-faint">→</span>
            <span className="rounded bg-primary-soft px-1 text-primary-soft-foreground">{correction.fixed}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-[30px] bg-ink text-background hover:bg-ink/90" onClick={() => onDecide(entry.index, 'accepted')}>采纳</Button>
            <Button size="sm" variant="outline" className="h-[30px]" onClick={() => onDecide(entry.index, 'ignored')}>忽略</Button>
            {correction.reason && <span className="text-xs text-faint">{correction.reason}</span>}
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <input
            key={`${entry.index}-${decision || 'orig'}-${correction?.fixed || ''}`}
            ref={(el) => registerInput(entry.index, el)}
            defaultValue={value}
            onChange={(e) => onTextChange(entry.index, e.target.value)}
            aria-label={`第 ${entry.index} 行字幕`}
            className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] leading-relaxed outline-none hover:border-border focus:border-ring focus:bg-card"
          />
          {correction && decision && (
            <button onClick={() => onDecide(entry.index, null)} className="px-2 text-xs text-faint hover:text-primary">
              {decision === 'accepted' ? '已采纳建议' : '已忽略建议'} · 撤回
            </button>
          )}
        </div>
      )}
    </div>
  )
})

export default function TranscriptReview({ jobId, status, onAdvance, onAction, mode = 'advance' }) {
  const entries = useState(() => (status.entries || []).map((e) => ({
    ...e, startSec: srtTimeToSeconds(e.start), endSec: srtTimeToSeconds(e.end),
  })))[0]

  // Editing an already-confirmed transcript starts from its saved text; the old
  // suggestions were settled when it was confirmed.
  const [corrections, setCorrections] = useState(() => {
    const map = {}
    if (mode !== 'edit') (status.suggested_corrections || []).forEach((c) => { map[c.index] = c })
    return map
  })
  // index → 'accepted' | 'ignored'; absent while a suggestion is still undecided.
  const [decisions, setDecisions] = useState({})
  const [selected, setSelected] = useState(() => new Set())
  const [activeIndex, setActiveIndex] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [noteDismissed, setNoteDismissed] = useState(() => {
    try { return localStorage.getItem(dismissedKey(jobId)) === status.claude_note } catch { return false }
  })

  const videoRef = useRef(null)
  const inputRefs = useRef({})
  const cuesRef = useRef({})

  const pendingCount = Object.keys(corrections).filter((i) => !decisions[i]).length

  const registerInput = useCallback((index, el) => { inputRefs.current[index] = el }, [])

  const onTextChange = useCallback((index, text) => {
    const cue = cuesRef.current[index]
    if (cue) cue.text = text
  }, [])

  const attachVideoRef = useCallback((el) => {
    videoRef.current = el
    if (!el) return
    Array.from(el.textTracks).forEach((t) => { t.mode = 'disabled' })
    const track = el.addTextTrack('subtitles', '字幕', 'ja')
    track.mode = 'showing'
    cuesRef.current = {}
    entries.forEach((e) => {
      const current = inputRefs.current[e.index]?.value ?? e.text
      const cue = new VTTCue(e.startSec, Math.max(e.endSec, e.startSec + 0.3), current)
      track.addCue(cue)
      cuesRef.current[e.index] = cue
    })
    el.addEventListener('timeupdate', () => {
      const t = el.currentTime
      let active = entries.find((e) => t >= e.startSec && t < e.endSec)
      if (!active) active = [...entries].reverse().find((e) => t >= e.startSec)
      const next = active ? active.index : null
      setActiveIndex((prev) => (next === prev ? prev : next))
    })
  }, [entries])

  const seekTo = useCallback((sec) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = sec
    v.play()
  }, [])

  const jumpToEntry = useCallback((index) => {
    const entry = entries.find((e) => e.index === index)
    const row = document.getElementById(`row-${index}`)
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.add('flash-row')
      setTimeout(() => row.classList.remove('flash-row'), 1600)
    }
    if (entry) seekTo(entry.startSec)
  }, [entries, seekTo])

  const decide = useCallback((index, decision) => {
    setDecisions((prev) => {
      const next = { ...prev }
      if (decision) next[index] = decision; else delete next[index]
      return next
    })
    const c = corrections[index]
    const entry = entries.find((e) => e.index === index)
    if (entry) onTextChange(index, decision === 'accepted' ? c.fixed : entry.text)
    if (decision) onAction?.(`${decision === 'accepted' ? '采纳' : '忽略'}了 #${index} 的修改`)
  }, [corrections, entries, onTextChange, onAction])

  const acceptAll = useCallback(() => {
    const undecided = Object.keys(corrections).filter((i) => !decisions[i])
    if (!undecided.length) return
    setDecisions((prev) => ({ ...prev, ...Object.fromEntries(undecided.map((i) => [i, 'accepted'])) }))
    undecided.forEach((i) => onTextChange(Number(i), corrections[i].fixed))
    onAction?.(`全部采纳了 ${undecided.length} 条建议`)
  }, [corrections, decisions, onTextChange, onAction])

  const toggleSelect = useCallback((index, checked) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(index); else next.delete(index)
      return next
    })
  }, [])

  const selectedList = useMemo(() => [...selected].sort((a, b) => a - b), [selected])
  const removeSelected = useCallback((index) => setSelected((prev) => { const n = new Set(prev); n.delete(index); return n }), [])
  const clearSelected = useCallback(() => setSelected(new Set()), [])

  // Corrections the AI assistant sent back: they come in as new undecided suggestions.
  const applyAIResult = useCallback((newCorrections) => {
    setCorrections((prev) => {
      const next = { ...prev }
      newCorrections.forEach((c) => { next[c.index] = c })
      return next
    })
    setDecisions((prev) => {
      const next = { ...prev }
      newCorrections.forEach((c) => { delete next[c.index] })
      return next
    })
    setTimeout(() => jumpToEntry(newCorrections[0].index), 50)
  }, [jumpToEntry])

  // Undecided suggestions count as accepted when the transcript is confirmed, the
  // same as before the diff view existed.
  const finalText = (e) => {
    const c = corrections[e.index]
    if (c && !decisions[e.index]) return c.fixed
    return inputRefs.current[e.index]?.value ?? e.text
  }

  const confirmTranscript = () => {
    setConfirming(true)
    const payload = entries.map((e) => ({ index: e.index, start: e.start, end: e.end, text: finalText(e) }))
    const endpoint = mode === 'edit' ? 'update_transcript' : 'transcript'
    onAction?.(mode === 'edit' ? '保存了字幕修改' : '确认了字幕')
    api.post(`/api/job/${jobId}/${endpoint}`, { entries: payload }).then(onAdvance).finally(() => setConfirming(false))
  }

  const setBridge = useContext(ChatBridgeContext)
  const confirmRef = useRef(confirmTranscript)
  confirmRef.current = confirmTranscript
  useEffect(() => {
    setBridge?.({
      selection: selectedList.map((i) => ({ index: i, text: entries.find((x) => x.index === i)?.text })),
      remove: removeSelected,
      clear: clearSelected,
      onResult: applyAIResult,
      locate: jumpToEntry,
      acceptAll,
      pendingCount,
      confirm: () => confirmRef.current(),
    })
  }, [setBridge, selectedList, entries, removeSelected, clearSelected, applyAIResult, jumpToEntry, acceptAll, pendingCount])
  useEffect(() => () => setBridge?.(null), [setBridge])

  const dismissNote = () => {
    try { localStorage.setItem(dismissedKey(jobId), status.claude_note) } catch { /* private mode */ }
    setNoteDismissed(true)
  }

  const summary = status.review_context

  return (
    <StepLayout
      className="flex gap-8 overflow-hidden pb-7"
      footer={(
        <>
          <span className="mr-auto text-[13px] text-muted-foreground">
            {pendingCount > 0 ? `还有 ${pendingCount} 条建议没处理，确认时按建议采纳` : `共 ${entries.length} 行`}
          </span>
          {pendingCount > 0 && <Button variant="outline" className="h-11" onClick={acceptAll}>全部采纳</Button>}
          <Button className="h-11 px-5" disabled={confirming} onClick={confirmTranscript}>
            {mode === 'edit' ? '保存修改' : '确认字幕，生成博客'}
          </Button>
        </>
      )}
    >
      {/* Each column scrolls on its own, so a long AI summary on the left stays reachable
          instead of running under the footer. */}
      <div className="flex w-[clamp(300px,36%,480px)] shrink-0 flex-col gap-4 overflow-y-auto pr-1">
        <video ref={attachVideoRef} controls src={jobFileUrl(jobId, 'source.mp4')} className="aspect-video w-full shrink-0 rounded-xl bg-black" />
        <Button variant="outline" size="sm" className="self-start" onClick={() => window.open(`/job/${jobId}/theater`, '_blank')}>
          <Maximize2 className="size-3.5" /> 大屏播放
        </Button>
        {Object.keys(corrections).length > 0 && mode !== 'edit' && (
          <div className="rounded-xl bg-primary-soft px-4 py-3.5 text-sm leading-relaxed text-primary-soft-foreground">
            AI 找到 <b>{Object.keys(corrections).length} 处</b>可能听错的地方，已在右边标出。逐条点「采纳」或「忽略」，也可以直接改文字。
          </div>
        )}
        {summary && (
          <div className="rounded-xl border bg-card px-4 py-3.5 text-[13px] leading-relaxed text-muted-foreground">{summary}</div>
        )}
        {status.claude_note && !noteDismissed && (
          <div className="flex items-start justify-between gap-3 rounded-xl bg-secondary px-4 py-3 text-xs text-muted-foreground">
            <span>{status.claude_note}</span>
            <button onClick={dismissNote} aria-label="知道了"><X className="size-3.5" /></button>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border bg-card">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-card px-4 py-3 text-[13px] text-muted-foreground">
          <span>共 {entries.length} 行 · 勾选几行可以让 AI 专门改这几行</span>
          {pendingCount > 0 && <span className="ml-auto shrink-0 text-primary-soft-foreground">{pendingCount} 条建议待处理</span>}
        </div>
        {entries.map((e) => (
          <EntryRow
            key={e.index}
            entry={e}
            correction={corrections[e.index]}
            decision={decisions[e.index]}
            isActive={activeIndex === e.index}
            selected={selected.has(e.index)}
            onToggleSelect={toggleSelect}
            onSeek={seekTo}
            onDecide={decide}
            registerInput={registerInput}
            onTextChange={onTextChange}
          />
        ))}
      </div>
    </StepLayout>
  )
}
