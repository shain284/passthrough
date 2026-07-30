import { PROGRESS_PREFIX } from './formats.ts'

export interface ProgressUpdate {
  downloadedBytes?: number
  totalBytes?: number
  totalIsEstimate?: boolean
  speed?: number
  eta?: number
}

/** yt-dlp prints "NA" for any progress field it does not have. */
function num(field: string | undefined): number | undefined {
  if (!field) return undefined
  const trimmed = field.trim()
  if (!trimmed || trimmed === 'NA' || trimmed === 'None') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Parses one PROG| line from --progress-template. Kept free of Electron imports
 * so the integration test can exercise it directly.
 */
export function parseProgressLine(line: string): ProgressUpdate | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null

  const parts = line.slice(PROGRESS_PREFIX.length).split('|')
  if (parts.length < 5) return null

  const downloaded = num(parts[0])
  const total = num(parts[1])
  const estimate = num(parts[2])

  // total_bytes is NA on fragmented streams; fall back to the estimate, and if
  // that is missing too leave totalBytes undefined so the bar goes indeterminate.
  return {
    downloadedBytes: downloaded,
    totalBytes: total ?? estimate,
    totalIsEstimate: total === undefined && estimate !== undefined,
    speed: num(parts[3]),
    eta: num(parts[4])
  }
}
