import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, Check, ChevronLeft, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { useLiveCalls } from '@/hooks/useLiveCalls'
import { ChatBridgeContext } from '@/lib/chat'
import { STEPS, stepState, activeStepKey, BUSY_STAGES, PROGRESS_LABEL } from '@/lib/steps'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import ChatPanel from '@/components/ChatPanel'
import LiveOutput from '@/components/LiveOutput'
import StepLayout from '@/components/StepLayout'
import JobInfo from '@/components/JobInfo'
import TranscriptReview from '@/components/stages/TranscriptReview'
import BlogReview from '@/components/stages/BlogReview'
import CaptionReview from '@/components/stages/CaptionReview'
import Done from '@/components/stages/Done'
import PodcastPanel from '@/components/stages/PodcastPanel'

const VIEWS = [['make', '制作'], ['podcast', '视频播客'], ['info', '基本信息']]

function Stepper({ status, selected, onSelect }) {
  return (
    <ol className="flex items-center gap-2 text-[13px]">
      {STEPS.map((step, i) => {
        const state = stepState(status, step)
        const isSelected = selected === step.key
        const clickable = state !== 'pending'
        return (
          <li key={step.key} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className={cn('h-px w-6', state === 'pending' ? 'bg-[#CFC9BB]' : 'bg-ink')} />}
            <button
              disabled={!clickable}
              onClick={() => onSelect(step.key)}
              aria-current={isSelected ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-1.5 py-1',
                clickable ? 'hover:bg-secondary' : 'cursor-default text-muted-foreground',
                isSelected && 'font-medium text-foreground',
              )}
            >
              <span className={cn(
                'flex size-[22px] items-center justify-center rounded-full text-xs',
                state === 'done' && 'bg-ink text-background',
                state === 'active' && 'bg-primary text-primary-foreground',
                state === 'error' && 'bg-destructive text-background',
                state === 'pending' && 'border border-[#CFC9BB]',
                isSelected && state === 'done' && 'ring-2 ring-primary/40',
              )}>
                {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : state === 'error' ? <AlertTriangle className="size-3" /> : i + 1}
              </span>
              {step.label}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function BusyBody({ status, live }) {
  return (
    <StepLayout>
      <div className="mx-auto mt-16 flex max-w-xl flex-col items-center gap-4 text-center">
        <Loader2 className="size-6 animate-spin text-primary" />
        <div className="text-[15px]">{status.progress_text || `${PROGRESS_LABEL[status.stage] || '处理中'}…`}</div>
        {status.stage === 'rendering_final' && typeof status.render_progress === 'number' && (
          <Progress value={status.render_progress} className="w-80" />
        )}
        <p className="text-[13px] text-muted-foreground">可以先去别的页面，好了会停在这里等你。</p>
      </div>
      {live.map((c) => <LiveOutput key={c.id} text={c.text} label={c.purpose} className="mx-auto mt-8 max-w-3xl" />)}
    </StepLayout>
  )
}

export default function JobDetail() {
  const { jobId } = useParams()
  const [pollInterval, setPollInterval] = useState(2000)
  const { data: status, refresh } = usePolling(
    () => api.get(`/api/job/${jobId}`),
    { intervalMs: pollInterval, deps: [jobId] },
  )
  const stage = status?.stage
  const [view, setView] = useState('make')
  const [selectedStep, setSelectedStep] = useState(STEPS[0].key)
  const [editEntries, setEditEntries] = useState(null)
  const [chatBridge, setChatBridge] = useState(null)
  const [chatVersion, setChatVersion] = useState(0)

  const currentKey = status ? activeStepKey(status) : null

  // Follow the pipeline forward as it advances; a click on an earlier step sticks
  // until the next stage change.
  useEffect(() => { if (currentKey) setSelectedStep(currentKey) }, [currentKey])

  useEffect(() => {
    if (!stage) return
    const podcastBusy = ['aligning', 'merging'].includes(status?.podcast_state) || status?.podcast_markup_state === 'generating' || status?.chat_pending
    setPollInterval((BUSY_STAGES.has(stage) || stage === 'uploaded' || podcastBusy) ? 2000 : 15000)
  }, [stage, status?.podcast_state, status?.podcast_markup_state, status?.chat_pending])

  const isCurrentStep = selectedStep === currentKey
  const editingTranscript = view === 'make' && selectedStep === 'transcript' && status?.confirmed_transcript
  useEffect(() => {
    if (editingTranscript) api.get(`/api/job/${jobId}/transcript_text`).then((d) => setEditEntries(d.entries || []))
  }, [editingTranscript, jobId])

  const liveCalls = useLiveCalls(jobId, (status?.ai_live_count || 0) > 0)
  const stageLive = liveCalls.filter((c) => !c.tag)

  const chatStep = view === 'make' ? selectedStep : view

  // Button clicks go into the AI chat history too, so what was said and what was
  // clicked read as one timeline.
  const logAction = useCallback((text) => {
    api.post(`/api/job/${jobId}/chat/event`, { text, step: chatStep })
      .then(() => setChatVersion((v) => v + 1))
      .catch(() => {})
  }, [jobId, chatStep])

  if (!status) {
    return <div className="flex h-screen items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  }

  const title = status.selected_title || status.video_name || jobId
  const retry = () => { logAction('重试这一步'); api.post(`/api/job/${jobId}/retry`).then(refresh) }
  const runStep = (path, text) => () => { logAction(text); api.post(`/api/job/${jobId}/${path}`).then(refresh) }
  const goTo = (key) => {
    if (key === 'podcast' || key === 'info') { setView(key); return }
    setView('make')
    setSelectedStep(key)
  }

  let body = null
  let chips = []
  if (view === 'info') {
    body = <JobInfo jobId={jobId} status={status} onRefresh={refresh} onAction={logAction} onGo={goTo} />
  } else if (view === 'podcast') {
    body = status.confirmed_transcript
      ? <StepLayout><PodcastPanel jobId={jobId} status={status} onRefresh={refresh} /></StepLayout>
      : <StepLayout><p className="text-sm text-muted-foreground">字幕确认之后，就可以用它来录视频播客。</p></StepLayout>
  } else if (isCurrentStep && stepState(status, STEPS.find((s) => s.key === selectedStep)) === 'error') {
    body = (
      <StepLayout footer={<Button className="h-11 px-5" onClick={retry}>重试这一步</Button>}>
        <h3 className="mb-3 font-semibold">这一步出错了</h3>
        <pre className="max-h-[480px] overflow-auto rounded-xl bg-destructive/5 p-4 text-xs whitespace-pre-wrap text-destructive">{status.error}</pre>
      </StepLayout>
    )
    chips = [{ label: '重试这一步', run: retry }]
  } else if (isCurrentStep && (BUSY_STAGES.has(stage) || stage === 'uploaded')) {
    body = <BusyBody status={status} live={stageLive} />
  } else if (selectedStep === 'transcript') {
    const entries = status.confirmed_transcript ? editEntries : status.entries
    body = entries == null
      ? <StepLayout><Loader2 className="size-5 animate-spin text-muted-foreground" /></StepLayout>
      : (
        <TranscriptReview
          key={`${jobId}-${status.confirmed_transcript ? 'edit' : 'review'}`}
          jobId={jobId}
          status={{ ...status, entries }}
          mode={status.confirmed_transcript ? 'edit' : 'advance'}
          onAction={logAction}
          onAdvance={() => {
            refresh()
            if (status.confirmed_transcript) api.get(`/api/job/${jobId}/transcript_text`).then((d) => setEditEntries(d.entries || []))
          }}
        />
      )
    if (chatBridge) {
      chips = [
        chatBridge.pendingCount > 0 && { label: '全部采纳', run: chatBridge.acceptAll },
        { label: status.confirmed_transcript ? '保存字幕修改' : '确认字幕，生成博客', run: chatBridge.confirm },
      ].filter(Boolean)
    }
  } else if (selectedStep === 'blog') {
    body = <BlogReview jobId={jobId} status={status} onAdvance={refresh} onAction={logAction} recap={!isCurrentStep} />
    if (isCurrentStep) {
      chips = [
        status.blog_path && { label: '重新生成', run: runStep('regenerate_blog', '重新生成博客文章') },
        status.blog_path && { label: '跳过博客', run: () => { if (confirm('不写这期博客？已生成的文章文件会被删除。')) runStep('discard_blog', '跳过了博客')() } },
        { label: status.blog_path ? '确认文章，做封面' : '跳过，做封面', run: runStep('confirm_blog', '确认了博客文章') },
      ].filter(Boolean)
    }
  } else if (selectedStep === 'caption') {
    body = <CaptionReview key={status.fontsize} jobId={jobId} status={status} onAdvance={refresh} onAction={logAction} recap={!isCurrentStep} />
    if (isCurrentStep) chips = [{ label: '导出成片', run: runStep('confirm_captions', '确认封面和字幕样式，开始导出成片') }]
  } else if (selectedStep === 'export') {
    body = stage === 'done'
      ? <Done jobId={jobId} status={status} onAdvance={refresh} onAction={logAction} />
      : <StepLayout><p className="text-sm text-muted-foreground">还没到这一步。</p></StepLayout>
  }

  const showChat = !['uploaded', 'transcribing'].includes(stage)
  const canInstruct = chatStep === 'transcript' && (status.confirmed_transcript || stage === 'transcript_review')

  return (
    <ChatBridgeContext.Provider value={setChatBridge}>
      <div className="flex h-screen flex-col bg-background">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-paper px-10">
          <Link to="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" />任务
          </Link>
          <h1 className="max-w-[320px] truncate text-[15px] font-medium" title={title}>{title}</h1>
          <nav className="ml-2 flex gap-0.5" aria-label="任务页面">
            {VIEWS.map(([key, label]) => (
              <button
                key={key} onClick={() => setView(key)} aria-current={view === key ? 'page' : undefined}
                className={cn('rounded-lg px-3 py-1.5 text-sm', view === key ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}
              >
                {label}
              </button>
            ))}
          </nav>
          {view === 'make' && (
            <div className="ml-auto"><Stepper status={status} selected={selectedStep} onSelect={setSelectedStep} /></div>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">{body}</div>
          {showChat && (
            <ChatPanel
              jobId={jobId}
              step={chatStep}
              pending={status.chat_pending}
              chatVersion={chatVersion}
              bridge={chatStep === 'transcript' ? chatBridge : null}
              onCorrections={() => { refresh(); goTo('transcript') }}
              chips={chips}
              canInstruct={canInstruct}
            />
          )}
        </div>
      </div>
    </ChatBridgeContext.Provider>
  )
}
