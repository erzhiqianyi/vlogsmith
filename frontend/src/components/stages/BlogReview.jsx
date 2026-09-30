import { useEffect, useState } from 'react'
import { Pencil, RefreshCw, Eye } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import BlogArticle from '@/components/BlogArticle'
import ExportBlogButton from '@/components/ExportBlogButton'
import StepLayout from '@/components/StepLayout'

const SIDE_BUTTON = 'h-11 w-full justify-start gap-2.5 bg-card font-normal'

// `recap` is the read-back of an already confirmed step: the article can still be
// edited and exported, but nothing here moves the pipeline.
export default function BlogReview({ jobId, status, onAdvance, onAction, recap = false }) {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (status.blog_path) {
      api.get(`/api/job/${jobId}/blog_content`).then((d) => { setContent(d.content || ''); setSaved(d.content || '') })
    }
  }, [jobId, status.blog_path])

  const run = (path, action) => {
    setBusy(true)
    onAction?.(action)
    api.post(`/api/job/${jobId}/${path}`).then(onAdvance).finally(() => setBusy(false))
  }
  const confirmBlog = () => run('confirm_blog', '确认了博客文章')
  const regenerate = () => run('regenerate_blog', '重新生成博客文章')
  const discard = () => {
    if (!confirm('不写这期博客？已生成的文章文件会被删除。')) return
    run('discard_blog', '跳过了博客')
  }
  const saveMarkdown = () => {
    api.post(`/api/job/${jobId}/blog_content`, { content }).then(() => {
      setSaved(content)
      setEditing(false)
      onAction?.('手动修改了博客文章')
    })
  }

  if (!status.blog_path) {
    return (
      <StepLayout
        footer={!recap && (
          <>
            <Button variant="outline" className="h-11" disabled={busy} onClick={regenerate}>再试一次</Button>
            <Button className="h-11 px-5" disabled={busy} onClick={confirmBlog}>跳过，做封面</Button>
          </>
        )}
      >
        {status.blog_error ? (
          <div className="max-w-2xl">
            <h3 className="mb-3 font-semibold">博客文章生成失败</h3>
            <pre className="mb-3 max-h-64 overflow-auto rounded-xl bg-destructive/5 p-3 text-xs whitespace-pre-wrap text-destructive">{status.blog_error}</pre>
            <p className="text-sm text-muted-foreground">可能是 AI 命令行工具没登录，可以到设置页检查。也可以先跳过，之后再补。</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">这一期跳过了博客文章。</p>
        )}
      </StepLayout>
    )
  }

  return (
    <StepLayout
      className="flex gap-8"
      footer={!recap && (
        <Button className="h-11 px-5" disabled={busy} onClick={confirmBlog}>确认文章，做封面</Button>
      )}
    >
      <article className="min-w-0 flex-1 self-start overflow-hidden">
        {editing ? (
          <div className="rounded-xl border bg-card p-6">
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} aria-label="博客 Markdown 原文" className="h-[520px] font-mono text-xs" />
            <div className="mt-3 flex gap-2">
              <Button onClick={saveMarkdown}>保存</Button>
              <Button variant="outline" onClick={() => { setContent(saved); setEditing(false) }}>取消</Button>
            </div>
          </div>
        ) : saved !== null && <BlogArticle markdown={saved} />}
      </article>

      <aside className="sticky top-0 flex w-60 shrink-0 flex-col gap-5 self-start">
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-muted-foreground">文章文件</div>
          <code className="rounded-lg bg-secondary px-3 py-2.5 font-mono text-xs leading-relaxed break-all">{status.blog_path}</code>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="outline" className={SIDE_BUTTON} onClick={() => setEditing(true)} disabled={editing}>
            <Pencil className="size-4" /> 改 Markdown 原文
          </Button>
          {status.blog_url && (
            <Button variant="outline" className={SIDE_BUTTON} asChild>
              <a href={status.blog_url} target="_blank" rel="noreferrer"><Eye className="size-4" /> 在博客里预览</a>
            </Button>
          )}
          <Button variant="outline" className={SIDE_BUTTON} disabled={busy} onClick={regenerate}>
            <RefreshCw className="size-4" /> 重新生成
          </Button>
          <ExportBlogButton jobId={jobId} status={status} onExported={() => { onAction?.('导出博客到博客仓库'); onAdvance() }} variant="outline" className={SIDE_BUTTON} />
        </div>
        {!recap && (
          <button onClick={discard} disabled={busy} className="self-start text-[13px] text-muted-foreground hover:text-foreground">
            不写博客，跳过这一步
          </button>
        )}
      </aside>
    </StepLayout>
  )
}
