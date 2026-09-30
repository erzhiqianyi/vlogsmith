import { useMemo } from 'react'
import { marked } from 'marked'
import '@/styles/blog-preview.css'

const SITE = 'https://erzhiqian.cc'

// The series writes frontmatter as one `"key": <json value>` pair per line.
function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { data: {}, body: text }
  const data = {}
  for (const line of m[1].split('\n')) {
    try { Object.assign(data, JSON.parse(`{${line}}`)) } catch { /* not a data line */ }
  }
  return { data, body: text.slice(m[0].length) }
}

function slugify(text, used) {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section'
  let slug = base
  for (let i = 1; used.has(slug); i++) slug = `${base}-${i}`
  used.add(slug)
  return slug
}

// Same post-processing the live post page does in the browser: heading ids for
// the TOC, and numbered chapters folded into <details> (only chapter 1 open).
function renderPost(body, isReview) {
  const doc = new DOMParser().parseFromString(`<div>${marked.parse(body)}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  const used = new Set()
  const toc = []
  root.querySelectorAll('h2, h3').forEach((h) => {
    h.id = slugify(h.textContent, used)
    toc.push({ id: h.id, text: h.textContent.trim(), depth: h.tagName === 'H3' ? 3 : 2 })
  })
  root.querySelectorAll('a[href^="/"]').forEach((a) => {
    a.href = SITE + a.getAttribute('href')
    a.target = '_blank'
    a.rel = 'noreferrer'
  })
  Array.from(root.querySelectorAll(':scope > h2')).forEach((heading) => {
    const isChapter = /^\d+\./.test(heading.textContent.trim())
    if (isReview && !isChapter) return
    const section = doc.createElement('details')
    section.className = 'article-section'
    section.open = !isReview || /^1\./.test(heading.textContent.trim())
    const summary = doc.createElement('summary')
    heading.replaceWith(section)
    summary.appendChild(heading)
    section.appendChild(summary)
    let node = section.nextSibling
    while (node && !(node.nodeType === 1 && node.tagName === 'H2')) {
      const next = node.nextSibling
      section.appendChild(node)
      node = next
    }
  })
  return { html: root.innerHTML, toc, reviewCount: root.querySelectorAll('.ct').length }
}

function reveal(id) {
  const target = document.getElementById(id)
  if (!target) return
  for (let box = target.closest('details'); box; box = box.parentElement?.closest('details')) box.open = true
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export default function BlogArticle({ markdown }) {
  const { data, html, toc, reviewCount } = useMemo(() => {
    const { data, body } = splitFrontmatter(markdown || '')
    return { data, ...renderPost(body, data.transcriptReview === true) }
  }, [markdown])

  const onClick = (e) => {
    const a = e.target.closest('a[href^="#"]')
    if (!a) return
    e.preventDefault()
    reveal(decodeURIComponent(a.getAttribute('href').slice(1)))
  }

  return (
    <div className="blog-preview rounded-md border">
      <div className="bp-layout">
        <article className="reading-article">
          <header className="reading-heading">
            <div className="reading-meta">
              {data.category && <span className="bp-cat">{data.category}</span>}
              {data.date && <time>{data.date}</time>}
              {data.transcriptReview && <span>字幕でふりかえる · {reviewCount} の表現</span>}
            </div>
            <h1>{data.title || data.date}</h1>
            {data.tags?.length > 0 && <p className="reading-tags">{data.tags.map((t) => <span key={t}>#{t}</span>)}</p>}
          </header>
          <div className="article-content" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        </article>

        {toc.length > 0 && (
          <aside className="bp-toc">
            <div className="bp-toc-title">目次<span className="toc-count">{toc.length}</span></div>
            <nav>
              {toc.map((h) => (
                <a key={h.id} className={h.depth === 3 ? 'nested' : undefined} onClick={() => reveal(h.id)}>{h.text}</a>
              ))}
            </nav>
          </aside>
        )}
      </div>
    </div>
  )
}
