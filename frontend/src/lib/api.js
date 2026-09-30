const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function handle(res) {
  let data
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok && !(data && 'error' in data)) {
    throw new Error(`HTTP ${res.status}`)
  }
  return data
}

export const api = {
  get: (path) => fetch(path).then(handle),
  post: (path, body) =>
    fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) }).then(handle),
  del: (path) => fetch(path, { method: 'DELETE' }).then(handle),
  upload: (path, formData, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', path)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('bad response'))
        }
      }
      xhr.onerror = () => reject(new Error('upload failed'))
      xhr.send(formData)
    }),
}

export function jobFileUrl(jobId, name) {
  return `/job/${jobId}/file/${name}`
}

// The job's main (YouTube) cover; versioned so a re-render shows up without a stale cache.
export function coverUrl(jobId, status) {
  return `${jobFileUrl(jobId, 'thumbnail.jpg')}?v=${status.cover_version ?? ''}`
}
