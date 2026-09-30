// The four steps of making a video, as shown in the job page's stepper. Each maps
// onto one or more backend stages; `confirmedKey` is the status flag set when the
// user signs the step off.
export const STEPS = [
  { key: 'transcript', label: '字幕', confirmedKey: 'confirmed_transcript', activeStages: ['uploaded', 'transcribing', 'transcript_review'] },
  { key: 'blog', label: '博客', confirmedKey: 'confirmed_blog', activeStages: ['blog_processing', 'blog_review'] },
  { key: 'caption', label: '封面', confirmedKey: 'confirmed_captions', activeStages: ['caption_processing', 'caption_review'] },
  { key: 'export', label: '导出', activeStages: ['rendering_final', 'done'] },
]

export function stepState(status, step) {
  if (step.key === 'export') {
    if (status.stage === 'done') return 'done'
    if (status.stage === 'rendering_final') return 'active'
    if (status.stage === 'error' && status.confirmed_captions) return 'error'
    return 'pending'
  }
  if (status[step.confirmedKey]) return 'done'
  if (step.activeStages.includes(status.stage)) return 'active'
  if (status.stage === 'error') {
    const idx = STEPS.findIndex((s) => s.confirmedKey && !status[s.confirmedKey])
    if (STEPS[idx]?.key === step.key) return 'error'
  }
  return 'pending'
}

export function activeStepKey(status) {
  const active = STEPS.find((s) => ['active', 'error'].includes(stepState(status, s)))
  if (active) return active.key
  if (status.stage === 'done') return 'export'
  return STEPS[0].key
}

export const BUSY_STAGES = new Set(['transcribing', 'blog_processing', 'caption_processing', 'rendering_final'])

export const PROGRESS_LABEL = {
  uploaded: '准备转录',
  transcribing: '转录中',
  blog_processing: '生成博客中',
  caption_processing: '准备封面和字幕样式',
  rendering_final: '导出中',
}
