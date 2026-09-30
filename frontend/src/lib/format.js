export function timeAgo(iso) {
  if (!iso) return ''
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function srtTimeToSeconds(t) {
  const [hms, ms] = t.split(',')
  const [h, m, s] = hms.split(':').map(Number)
  return h * 3600 + m * 60 + s + (parseInt(ms, 10) || 0) / 1000
}

export const STAGE_LABELS = {
  uploaded: '已上传',
  transcribing: '转录中',
  transcript_review: '确认字幕',
  blog_processing: '生成博客',
  blog_review: '确认博客',
  caption_processing: '生成字幕样式',
  caption_review: '确认字幕样式',
  rendering_final: '导出成片',
  done: '完成',
  error: '出错',
}

export const STAGE_ORDER = [
  'uploaded', 'transcribing', 'transcript_review', 'blog_processing', 'blog_review',
  'caption_processing', 'caption_review',
  'rendering_final', 'done',
]

export function stageBadgeClass(stage) {
  if (stage === 'done') return 'border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
  if (stage === 'error') return 'border-transparent bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
  if (stage.endsWith('_review') || stage === 'uploaded') return 'border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
  return 'border-transparent bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400'
}

export function formatTokens(n) {
  if (!n) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n)
}

// "31.2k 入 / 241 出 · $0.09" from a recorded call's usage summary.
export function formatUsage(u) {
  if (!u) return ''
  const input = (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_creation_tokens || 0)
  const cost = u.cost_usd != null ? ` · $${u.cost_usd.toFixed(u.cost_usd < 1 ? 3 : 2)}` : ''
  return `${formatTokens(input)} 入 / ${formatTokens(u.output_tokens)} 出${cost}`
}

// Which bucket of the dashboard a job's stage falls into.
export function stageKind(stage) {
  if (stage === 'done') return 'done'
  if (stage === 'error') return 'error'
  if (stage?.endsWith('_review')) return 'review'
  return 'processing'
}

export const PODCAST_LABELS = {
  recorded: '已录音',
  merging: '合成中',
  aligning: '对齐中',
  aligned: '已对齐',
  error: '出错',
}

export function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function monthLabel(iso) {
  if (!iso) return '未知日期'
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}
