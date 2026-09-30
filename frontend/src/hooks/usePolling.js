import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * Polls `fetcher()` every `intervalMs` while `enabled` is true. Always fetches
 * once immediately when enabled flips true. Returns the latest data plus a
 * manual `refresh()` you can call after an action.
 */
export function usePolling(fetcher, { enabled = true, intervalMs = 2000, deps = [] } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refresh = useCallback(() => {
    return fetcherRef.current()
      .then((d) => { setData(d); setError(null); return d })
      .catch((e) => { setError(e); throw e })
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    let timer = null

    const tick = () => {
      fetcherRef.current()
        .then((d) => { if (!cancelled) { setData(d); setError(null) } })
        .catch((e) => { if (!cancelled) setError(e) })
        .finally(() => { if (!cancelled) timer = setTimeout(tick, intervalMs) })
    }
    tick()

    return () => { cancelled = true; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps])

  return { data, error, refresh }
}
