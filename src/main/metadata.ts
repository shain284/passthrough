import { execFile } from 'node:child_process'
import type { VideoMeta } from '../shared/types.ts'
import { jsRuntimeArgs, spawnEnv, ytDlpPath } from './binaries.ts'
import { buildMetaArgs } from './formats.ts'
import { mapError } from './errors.ts'
import { log } from './logger.ts'
import { normalizeUrl } from './urls.ts'

interface DumpJson {
  id?: string
  title?: string
  thumbnail?: string
  thumbnails?: { url?: string; preference?: number; height?: number }[]
  duration?: number
  uploader?: string
  channel?: string
  uploader_id?: string
  extractor_key?: string
  extractor?: string
  _type?: string
  entries?: DumpJson[]
}

function pickThumbnail(json: DumpJson): string | undefined {
  if (typeof json.thumbnail === 'string' && json.thumbnail) return json.thumbnail
  const list = json.thumbnails ?? []
  // Prefer something in the 200–500px band; a 4K thumbnail in a 64px slot is waste.
  const usable = list.filter((t) => typeof t.url === 'string')
  if (!usable.length) return undefined
  const mid = usable.find((t) => (t.height ?? 0) >= 180 && (t.height ?? 0) <= 720)
  return (mid ?? usable[usable.length - 1]).url
}

/**
 * `yt-dlp --dump-single-json --no-download`, run the moment a valid URL lands in
 * the input so the row can appear with a title and thumbnail before any bytes move.
 */
export function fetchMeta(rawUrl: string, useCookies: boolean): Promise<VideoMeta> {
  const url = normalizeUrl(rawUrl)
  if (!url) return Promise.reject(new Error('That link is not a supported YouTube or TikTok URL.'))

  return new Promise((resolve, reject) => {
    execFile(
      ytDlpPath,
      buildMetaArgs(url, useCookies, jsRuntimeArgs()),
      { timeout: 45000, windowsHide: true, env: spawnEnv(), maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr) log('meta', stderr)
        if (err && !stdout.trim()) {
          reject(new Error(mapError(stderr || err.message, null).message))
          return
        }
        try {
          let json = JSON.parse(stdout) as DumpJson
          // --no-playlist normally prevents this, but a channel URL can still come
          // back as a playlist wrapper. Take the first entry.
          if (json._type === 'playlist' && json.entries?.length) json = json.entries[0]!

          resolve({
            id: json.id ?? '',
            title: json.title?.trim() || 'Untitled',
            thumbnail: pickThumbnail(json),
            duration: typeof json.duration === 'number' ? json.duration : undefined,
            uploader: json.uploader || json.channel || json.uploader_id || undefined,
            extractor: json.extractor_key || json.extractor || undefined
          })
        } catch {
          reject(new Error(mapError(stderr || 'Could not read video info.', null).message))
        }
      }
    )
  })
}
