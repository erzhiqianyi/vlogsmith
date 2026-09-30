// YouTube publish defaults set on the Settings page. Kept in this browser only —
// they just prefill the publish form.
const KEY = 'publishDefaults'
const FALLBACK = { privacy: 'private', tags: 'vlog,日本語学習' }

export function loadPublishDefaults() {
  try {
    return { ...FALLBACK, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return FALLBACK
  }
}

export function savePublishDefaults(value) {
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* private mode */ }
}
