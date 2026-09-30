import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Check, Copy, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { api } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { loadPublishDefaults, savePublishDefaults } from '@/lib/publishDefaults'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { UsageCard } from '@/components/AIUsage'

// Starting points for a new CLI entry; everything stays editable. Only the Claude
// preset is what the app was built and tested against.
const PRESETS = {
  claude: { label: 'Claude Code', command: 'claude -p --output-format stream-json --verbose --include-partial-messages', input_mode: 'stdin', response_format: 'stream_json', json_result_key: 'result' },
  gemini: { label: 'Gemini CLI', command: 'gemini -p', input_mode: 'arg', response_format: 'text', json_result_key: '' },
  codex: { label: 'Codex CLI', command: 'codex exec', input_mode: 'arg', response_format: 'text', json_result_key: '' },
  custom: { label: '', command: '', input_mode: 'stdin', response_format: 'text', json_result_key: '' },
}

const SECTIONS = [['env', '环境检查'], ['cli', 'AI 命令行工具'], ['usage', 'AI 用量'], ['yt', 'YouTube']]

function SectionHead({ id, title, hint, children }) {
  return (
    <div id={id} className="flex scroll-mt-20 items-end gap-3">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {hint && <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="ml-auto flex gap-2">{children}</div>
    </div>
  )
}

function StatusIcon({ ok }) {
  return ok
    ? <Check className="size-[18px] text-success" strokeWidth={2.5} aria-label="正常" />
    : <AlertCircle className="size-[18px] text-primary" aria-label="需要处理" />
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast.success('已复制'))
}

function EnvRow({ ok, name, children, action }) {
  return (
    <div className={cn('grid grid-cols-[24px_180px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 px-5 py-3.5 last:border-0', !ok && 'bg-primary-soft/30')}>
      <StatusIcon ok={ok} />
      <span className="text-sm font-medium">{name}</span>
      <span className="text-[13px] text-muted-foreground">{children}</span>
      {action || <span />}
    </div>
  )
}

function EnvCheck({ env, onRecheck, checking }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHead id="env" title="环境检查" hint="每次打开设置页自动检查一次">
        <Button variant="outline" size="sm" className="h-9 bg-card" onClick={onRecheck} disabled={checking}>
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} 重新检查
        </Button>
      </SectionHead>
      <div className="rounded-xl border bg-card">
        {!env ? (
          <div className="p-5"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            {env.providers.filter((p) => p.command.length).map((p) => (
              <EnvRow
                key={p.name} ok={p.installed} name={p.label}
                action={!p.installed && p.command[0] && (
                  <Button variant="outline" size="sm" onClick={() => copy(p.command[0])}><Copy className="size-3.5" />复制命令名</Button>
                )}
              >
                {p.installed
                  ? <>已安装 · 能不能用（有没有登录）点下面的「测试」确认</>
                  : <>找不到 <code className="rounded bg-secondary px-1.5 font-mono text-xs">{p.command[0]}</code>，装好后确认它在 PATH 里</>}
              </EnvRow>
            ))}
            <EnvRow ok={env.ffmpeg.ok && env.ffmpeg.libass} name="ffmpeg-full">
              {!env.ffmpeg.ok ? '找不到 ffmpeg，运行 brew install ffmpeg-full'
                : env.ffmpeg.libass ? '已安装 · 带 libass，可以烧字幕'
                  : '找到的 ffmpeg 不带 libass，烧字幕会失败。运行 brew install ffmpeg-full'}
            </EnvRow>
            <EnvRow ok={env.whisper.ok} name="Whisper">{env.whisper.ok ? '已安装' : '没装 openai-whisper，转录会失败'}</EnvRow>
            <EnvRow ok={env.blog_dir.ok} name="博客目录">
              <code className="font-mono text-xs break-all">{env.blog_dir.path}</code>{!env.blog_dir.ok && ' · 目录不存在'}
            </EnvRow>
          </>
        )}
      </div>
    </section>
  )
}

function CliCard({ name, p, active, selected, onSelect, onTest, testing, result }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-xl border bg-card p-4.5',
        active && 'border-ink border-[1.5px]',
        selected && 'ring-3 ring-primary-soft',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('size-2 rounded-full', result?.ok ? 'bg-success' : result ? 'bg-primary' : 'bg-[#CFC9BB]')} aria-hidden />
        <span className="truncate text-[15px] font-bold">{p.label || name}</span>
        {active && <span className="ml-auto rounded-full bg-ink px-2 py-0.5 text-[11px] text-background">默认</span>}
      </div>
      <code className="truncate font-mono text-[11px] text-muted-foreground">{(p.command || []).join(' ') || '还没填命令'}</code>
      {result && (
        <p className={cn('line-clamp-2 text-xs', result.ok ? 'text-success' : 'text-destructive')}>
          {result.ok ? `可用：${result.output}` : result.error}
        </p>
      )}
      <div className="flex gap-3 text-[13px]">
        <button onClick={onTest} disabled={testing} className="text-primary hover:underline disabled:text-muted-foreground">
          {testing ? '测试中…' : '测试'}
        </button>
        <button onClick={onSelect} className="text-primary hover:underline">编辑</button>
      </div>
    </div>
  )
}

function CliEditor({ name, initial, isNew, isActive, onSaved, onDeleted, onCancel }) {
  const [form, setForm] = useState(initial)
  const [preset, setPreset] = useState(isNew ? 'custom' : null)
  const [saving, setSaving] = useState(false)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  const applyPreset = (key) => { setPreset(key); setForm({ ...PRESETS[key], label: PRESETS[key].label || form.label }) }

  const save = async (makeDefault = false) => {
    if (!form.label.trim() || !form.command.trim()) { toast.error('名称和命令都要填'); return }
    setSaving(true)
    const id = name || form.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `cli-${Date.now()}`
    try {
      await api.post('/api/ai/config', {
        providers: { [id]: form },
        ...(makeDefault ? { active: id } : {}),
      })
      toast.success('已保存')
      onSaved(id)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(`删除「${form.label}」？`)) return
    await api.post('/api/ai/config', { delete: [name] })
    onDeleted()
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-2 text-[15px] font-bold">{isNew ? '添加命令行工具' : `编辑：${initial.label || name}`}</h3>
        <span className="text-xs text-muted-foreground">从预设开始：</span>
        {Object.entries(PRESETS).map(([key, p]) => (
          <button
            key={key} onClick={() => applyPreset(key)}
            className={cn('h-7 rounded-full border px-2.5 text-xs', preset === key ? 'border-ink bg-ink text-background' : 'bg-card hover:bg-secondary')}
          >
            {p.label || '自定义'}
          </button>
        ))}
        <button onClick={onCancel} aria-label="关闭" className="ml-auto rounded p-1 text-muted-foreground hover:bg-secondary"><X className="size-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cli-label" className="text-[13px] font-normal text-muted-foreground">名称</Label>
          <Input id="cli-label" value={form.label} onChange={(e) => set('label')(e.target.value)} className="h-10" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cli-command" className="text-[13px] font-normal text-muted-foreground">命令（按 shell 写法）</Label>
          <Input id="cli-command" value={form.command} onChange={(e) => set('command')(e.target.value)} className="h-10 font-mono text-[13px]" placeholder="your-cli --flag" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px] font-normal text-muted-foreground">prompt 怎么传进去</Label>
          <Select value={form.input_mode} onValueChange={set('input_mode')}>
            <SelectTrigger className="w-full data-[size=default]:h-10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stdin">标准输入（stdin）</SelectItem>
              <SelectItem value="arg">追加为最后一个参数</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px] font-normal text-muted-foreground">输出格式</Label>
          <Select value={form.response_format} onValueChange={set('response_format')}>
            <SelectTrigger className="w-full data-[size=default]:h-10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="text">纯文本</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="stream_json">流式 JSON（Claude Code）</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {form.response_format !== 'text' && (
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label htmlFor="cli-key" className="text-[13px] font-normal text-muted-foreground">结果字段路径（比如 result 或 data.text）</Label>
            <Input id="cli-key" value={form.json_result_key} onChange={(e) => set('json_result_key')(e.target.value)} className="h-10 font-mono text-[13px]" />
          </div>
        )}
      </div>
      <div className="flex gap-2">
        {!isNew && !isActive && (
          <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={remove}>删除</Button>
        )}
        <div className="ml-auto flex gap-2">
          {!isActive && <Button variant="outline" disabled={saving} onClick={() => save(true)}>保存并设为默认</Button>}
          <Button disabled={saving} onClick={() => save(false)}>保存</Button>
        </div>
      </div>
    </div>
  )
}

function CliSettings({ onChanged }) {
  const [config, setConfig] = useState(null)
  const [editing, setEditing] = useState(null) // provider name, or '__new__'
  const [testing, setTesting] = useState(null)
  const [results, setResults] = useState({})

  const load = () => api.get('/api/ai/config').then(setConfig)
  useEffect(() => { load() }, [])

  const test = (name) => {
    setTesting(name)
    api.post('/api/ai/test', { provider: name })
      .then((res) => setResults((r) => ({ ...r, [name]: res })))
      .finally(() => setTesting(null))
  }

  if (!config) return <Loader2 className="size-4 animate-spin text-muted-foreground" />

  const entries = Object.entries(config.providers || {})
  const editingNew = editing === '__new__'
  const editingProvider = !editingNew && editing && config.providers[editing]

  return (
    <section className="flex flex-col gap-3.5">
      <SectionHead id="cli" title="AI 命令行工具" hint="可以配好几个，默认的那个跑自动步骤；在 AI 助手里可以临时换一个">
        <Button size="sm" className="h-9 bg-ink text-background hover:bg-ink/90" onClick={() => setEditing('__new__')}>
          <Plus className="size-3.5" /> 添加
        </Button>
      </SectionHead>
      <div className="grid grid-cols-3 gap-3">
        {entries.map(([name, p]) => (
          <CliCard
            key={name} name={name} p={p} active={config.active === name} selected={editing === name}
            onSelect={() => setEditing(name)} onTest={() => test(name)} testing={testing === name} result={results[name]}
          />
        ))}
      </div>
      {(editingNew || editingProvider) && (
        <CliEditor
          key={editing}
          name={editingNew ? null : editing}
          isNew={editingNew}
          isActive={config.active === editing}
          initial={editingNew ? PRESETS.custom : {
            label: editingProvider.label || editing,
            command: (editingProvider.command || []).join(' '),
            input_mode: editingProvider.input_mode || 'stdin',
            response_format: editingProvider.response_format || 'text',
            json_result_key: editingProvider.json_result_key || '',
          }}
          onSaved={(id) => { load().then(() => setEditing(null)); test(id); onChanged() }}
          onDeleted={() => { load(); setEditing(null); onChanged() }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  )
}

function YoutubeSettings() {
  const { data: yt, refresh } = usePolling(() => api.get('/api/youtube/status'), { intervalMs: 3000 })
  const [defaults, setDefaults] = useState(loadPublishDefaults)
  const updateDefaults = (patch) => setDefaults((d) => { const next = { ...d, ...patch }; savePublishDefaults(next); return next })

  const stepDot = (done, n) => (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-[13px]', done ? 'bg-ink text-background' : 'bg-primary text-primary-foreground')}>
      {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
    </span>
  )

  return (
    <section className="flex flex-col gap-3.5">
      <SectionHead id="yt" title="YouTube" hint="可选。不配置也不影响其他步骤" />
      {!yt ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : (
        <div className="rounded-xl border bg-card">
          <div className="flex items-start gap-4 border-b border-border/60 px-6 py-4.5">
            {stepDot(yt.configured, 1)}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">放好 OAuth 客户端文件</div>
              <div className="mt-0.5 font-mono text-xs break-all text-muted-foreground">{yt.client_secret_path}{yt.configured ? ' · 已找到' : ' · 还没找到'}</div>
              {!yt.configured && (
                <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                  <li>打开 <a className="text-primary hover:underline" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a>，新建或选一个项目</li>
                  <li>「APIs &amp; Services → Library」启用 <b>YouTube Data API v3</b></li>
                  <li>「Credentials → Create Credentials → OAuth client ID」，类型选 <b>Desktop app</b></li>
                  <li>下载 JSON，改名放到上面这个路径</li>
                </ol>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 px-6 py-4.5">
            {stepDot(yt.connected, 2)}
            {yt.connected && yt.channel ? (
              <>
                <div className="flex-1 text-sm">已连接：<b>{yt.channel.title}</b></div>
                <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => {
                  if (!confirm('断开后要重新授权才能发布，确定断开？')) return
                  api.post('/api/youtube/disconnect').then(refresh)
                }}>断开</Button>
              </>
            ) : (
              <>
                <div className="flex-1">
                  <div className="text-sm font-medium">连接频道</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">会打开浏览器让你登录 Google 并授权，只要做一次</div>
                  {yt.oauth_error && <div className="mt-1 text-xs text-destructive">上次授权失败：{yt.oauth_error}</div>}
                </div>
                <Button disabled={!yt.configured || yt.oauth_in_progress} onClick={() => api.post('/api/youtube/connect').then(() => setTimeout(refresh, 500))}>
                  {yt.oauth_in_progress ? <><Loader2 className="size-4 animate-spin" />等浏览器授权…</> : '连接 YouTube'}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3.5 rounded-xl border bg-card px-6 py-5">
        <div>
          <h3 className="text-[15px] font-bold">发布默认值</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">只是预先填好发布表单，发布前还能改。发布后会自动把视频链接写回博客文章。</p>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3.5">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-normal text-muted-foreground">默认可见性</Label>
            <Select value={defaults.privacy} onValueChange={(v) => updateDefaults({ privacy: v })}>
              <SelectTrigger className="w-full data-[size=default]:h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="private">私享</SelectItem>
                <SelectItem value="unlisted">不公开</SelectItem>
                <SelectItem value="public">公开</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-tags" className="text-[13px] font-normal text-muted-foreground">每次都带上的标签</Label>
            <Input id="default-tags" value={defaults.tags} onChange={(e) => updateDefaults({ tags: e.target.value })} className="h-10" />
          </div>
        </div>
      </div>
    </section>
  )
}

export default function Settings() {
  const [env, setEnv] = useState(null)
  const [checking, setChecking] = useState(false)
  const check = () => {
    setChecking(true)
    api.get('/api/env').then(setEnv).catch(() => toast.error('环境检查失败')).finally(() => setChecking(false))
  }
  useEffect(check, [])

  const envProblem = env && (
    env.providers.some((p) => p.command.length && !p.installed) || !env.ffmpeg.ok || !env.ffmpeg.libass || !env.whisper.ok || !env.blog_dir.ok
  )

  return (
    <div className="mx-auto flex max-w-[1280px] gap-12 px-10 py-8">
      <nav aria-label="设置分类" className="sticky top-22 flex w-44 shrink-0 flex-col gap-0.5 self-start text-sm">
        <h1 className="mb-4 ml-3 text-[22px] font-bold">设置</h1>
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="flex h-10 items-center rounded-lg px-3 text-foreground/80 hover:bg-secondary">
            {label}
            {id === 'env' && envProblem && <span className="ml-auto size-2 rounded-full bg-primary" aria-label="有问题" />}
          </a>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-10">
        <EnvCheck env={env} onRecheck={check} checking={checking} />
        <CliSettings onChanged={check} />
        <section id="usage" className="scroll-mt-20"><UsageCard /></section>
        <YoutubeSettings />
      </div>
    </div>
  )
}
