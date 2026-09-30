import { useState } from 'react'
import { FileDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

// One-click copy of the job's blog.md into the blog repo as this episode's post.
export default function ExportBlogButton({ jobId, status, onExported, ...props }) {
  const [busy, setBusy] = useState(false)

  const exportBlog = async (overwrite = false) => {
    setBusy(true)
    try {
      const res = await api.post(`/api/job/${jobId}/export_blog`, { overwrite })
      if (res?.error === 'exists') {
        if (confirm(`博客仓库里已经有一篇内容不同的文章：\n${res.path}\n\n要用这篇覆盖它吗？`)) await exportBlog(true)
        return
      }
      if (res?.error) throw new Error(res.error)
      toast.success(`已导出到 ${res.path}`)
      onExported?.()
    } catch (e) {
      toast.error(`导出失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Button disabled={busy} onClick={() => exportBlog()} {...props}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />} 导出到博客
      </Button>
      {status.blog_exported_path && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          上次导出：<code className="rounded bg-muted px-1">{status.blog_exported_path}</code>
        </p>
      )}
    </div>
  )
}
