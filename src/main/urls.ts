/**
 * Host allowlist. Nothing reaches yt-dlp without passing through here first.
 */
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com'
])

export function isAllowedUrl(raw: string): boolean {
  return normalizeUrl(raw) !== null
}

/**
 * Returns a normalized https URL if the input is an allowed YouTube/TikTok link,
 * otherwise null. Strips nothing beyond whitespace — playlist params are handled
 * by --no-playlist, not by rewriting the user's link.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed.length > 2048) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password) return null

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!ALLOWED_HOSTS.has(host)) return null

  parsed.protocol = 'https:'
  parsed.hash = ''
  return parsed.toString()
}

export function hostLabel(url: string): 'youtube' | 'tiktok' | 'unknown' {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('tiktok')) return 'tiktok'
    if (host.includes('youtu')) return 'youtube'
  } catch {
    /* fall through */
  }
  return 'unknown'
}
