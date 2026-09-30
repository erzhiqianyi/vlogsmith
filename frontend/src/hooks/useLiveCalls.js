import { api } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'

// AI CLI calls still running for this job, with their output streamed so far.
export function useLiveCalls(jobId, enabled) {
  const { data } = usePolling(() => api.get(`/api/job/${jobId}/ai_live`), {
    enabled, intervalMs: 800, deps: [jobId],
  })
  return enabled ? (data?.calls || []) : []
}
