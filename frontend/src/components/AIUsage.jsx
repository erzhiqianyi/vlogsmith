import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { formatUsage } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const WINDOW_LABELS = { five_hour: '5 小时', seven_day: '7 天' }

function useUsage(intervalMs) {
  return usePolling(() => api.get('/api/ai/usage'), { intervalMs }).data
}

function windows(usage) {
  const w = usage?.rate_limit?.unifiedWindows || {}
  return Object.entries(WINDOW_LABELS).filter(([k]) => w[k]).map(([k, label]) => ({
    key: k, label, pct: Math.round((w[k].utilization || 0) * 100),
    resetsAt: w[k].resetsAt ? new Date(w[k].resetsAt * 1000) : null,
  }))
}

function barColor(pct) {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 75) return 'bg-amber-500'
  return 'bg-primary'
}

function Bar({ pct, className }) {
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full', barColor(pct))} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

// Compact account-quota readout for the chat panel header.
export function UsageMeter() {
  const usage = useUsage(60000)
  const ws = windows(usage)
  if (!ws.length) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {ws.map((w) => (
            <div key={w.key} className="w-14">
              <div className="flex justify-between"><span>{w.label}</span><span>{w.pct}%</span></div>
              <Bar pct={w.pct} className="mt-0.5" />
            </div>
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Claude 账号额度已用比例（最近一次调用时的数据）
        {ws.map((w) => w.resetsAt && <div key={w.key}>{w.label}窗口 {w.resetsAt.toLocaleString()} 重置</div>)}
      </TooltipContent>
    </Tooltip>
  )
}

function Stat({ label, total }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{total?.calls || 0} 次调用</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{total?.calls ? formatUsage(total) : '—'}</div>
    </div>
  )
}

export function UsageCard() {
  const usage = useUsage(30000)
  if (!usage) return <Card className="p-6"><Loader2 className="size-4 animate-spin" /></Card>
  const ws = windows(usage)
  const purposes = Object.entries(usage.by_purpose || {})

  return (
    <Card className="p-6">
      <h3 className="mb-1 font-semibold">CLI 使用量</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        账号额度来自 Claude Code CLI 最近一次调用时的回报{usage.updated_at && `（${new Date(usage.updated_at).toLocaleString()}）`}；
        下面的次数、token 和费用是这个工具自己记下的。费用是 CLI 按 API 价格估算的，订阅用户实际按额度计。
      </p>

      {ws.length > 0 ? (
        <div className="mb-5 space-y-3">
          {ws.map((w) => (
            <div key={w.key}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{w.label}额度</span>
                <span className="text-muted-foreground">
                  已用 {w.pct}%{w.resetsAt && ` · ${w.resetsAt.toLocaleString()} 重置`}
                </span>
              </div>
              <Bar pct={w.pct} className="h-2" />
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-5 text-xs text-muted-foreground">还没有额度数据，调用一次 Claude Code CLI 后就会显示。</p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat label="最近 24 小时" total={usage.last_24h} />
        <Stat label="最近 7 天" total={usage.last_7d} />
        <Stat label="全部" total={usage.all_time} />
      </div>

      {purposes.length > 0 && (
        <table className="mt-5 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-1.5 font-normal">用途</th>
              <th className="pb-1.5 font-normal">次数</th>
              <th className="pb-1.5 font-normal">用量</th>
            </tr>
          </thead>
          <tbody>
            {purposes.map(([name, t]) => (
              <tr key={name} className="border-t">
                <td className="py-1.5">{name}</td>
                <td className="py-1.5">{t.calls}</td>
                <td className="py-1.5 text-muted-foreground">{formatUsage(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
