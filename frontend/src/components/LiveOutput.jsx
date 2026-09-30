import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// The raw output of an in-flight AI call as it streams in, pinned to the newest text.
export default function LiveOutput({ text, label, className }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [text])
  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {label}{text ? ` · 已输出 ${text.length.toLocaleString()} 字` : ' · 等待 AI 开始输出…'}
      </div>
      {text && (
        <pre ref={ref} className={cn('max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2.5 font-mono text-xs leading-relaxed')}>
          {text}<span className="animate-pulse">▍</span>
        </pre>
      )}
    </div>
  )
}
