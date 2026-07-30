import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { FormatId } from '@shared/types'
import { spawnEnv, ytDlpPath } from './binaries'
import { FILE_PREFIX, POSTPROCESS_PREFIX, PROGRESS_PREFIX, buildDownloadArgs } from './formats'
import { log } from './logger'
import { killTree } from './proc'

export interface ProgressUpdate {
  downloadedBytes?: number
  totalBytes?: number
  totalIsEstimate?: boolean
  speed?: number
  eta?: number
}

export interface RunOptions {
  url: string
  format: FormatId
  outputDir: string
  useCookies: boolean
  keepMkv?: boolean
  onProgress(p: ProgressUpdate): void
  onProcessing(): void
}

export interface RunResult {
  code: number | null
  killed: boolean
  stderr: string
  filePath?: string
}

export interface RunHandle {
  child: ChildProcess
  result: Promise<RunResult>
  kill(): void
}

/** yt-dlp prints "NA" for any progress field it does not have. */
function num(field: string | undefined): number | undefined {
  if (!field) return undefined
  const trimmed = field.trim()
  if (!trimmed || trimmed === 'NA' || trimmed === 'None') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

function parseProgress(line: string): ProgressUpdate | null {
  const parts = line.slice(PROGRESS_PREFIX.length).split('|')
  if (parts.length < 5) return null

  const downloaded = num(parts[0])
  const total = num(parts[1])
  const estimate = num(parts[2])
  const speed = num(parts[3])
  const eta = num(parts[4])

  // total_bytes is NA on fragmented streams; fall back to the estimate, and if
  // that is missing too leave totalBytes undefined so the bar goes indeterminate.
  const resolvedTotal = total ?? estimate

  return {
    downloadedBytes: downloaded,
    totalBytes: resolvedTotal,
    totalIsEstimate: total === undefined && estimate !== undefined,
    speed,
    eta
  }
}

/**
 * Spawns yt-dlp for one download. Args are always an array — no shell, no string
 * interpolation, and the URL is passed after `--`.
 */
export function runDownload(opts: RunOptions): RunHandle {
  const args = buildDownloadArgs({
    url: opts.url,
    format: opts.format,
    outputDir: opts.outputDir,
    useCookies: opts.useCookies,
    keepMkv: opts.keepMkv
  })

  log('spawn', `${ytDlpPath} ${args.join(' ')}`)

  const child = spawn(ytDlpPath, args, {
    windowsHide: true,
    env: spawnEnv(),
    // A process group on POSIX so cancel can take ffmpeg down with it.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let killed = false
  let stderr = ''
  let filePath: string | undefined
  let lastEmit = 0
  let pendingProgress: ProgressUpdate | null = null
  let flushTimer: NodeJS.Timeout | null = null

  // ~10 updates/sec. IPC is cheap but React re-renders on every row are not.
  const THROTTLE_MS = 100

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!pendingProgress) return
    lastEmit = Date.now()
    const p = pendingProgress
    pendingProgress = null
    opts.onProgress(p)
  }

  const emitProgress = (p: ProgressUpdate): void => {
    pendingProgress = p
    const since = Date.now() - lastEmit
    if (since >= THROTTLE_MS) {
      flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, THROTTLE_MS - since)
    }
  }

  const handleLine = (line: string, channel: 'out' | 'err'): void => {
    const trimmed = line.trim()
    if (!trimmed) return

    if (trimmed.startsWith(PROGRESS_PREFIX)) {
      const p = parseProgress(trimmed)
      if (p) emitProgress(p)
      return
    }

    if (trimmed.startsWith(POSTPROCESS_PREFIX)) {
      flush()
      opts.onProcessing()
      log('pp', trimmed)
      return
    }

    if (trimmed.startsWith(FILE_PREFIX)) {
      const p = trimmed.slice(FILE_PREFIX.length).trim()
      if (p && p !== 'NA') filePath = p
      log('file', p)
      return
    }

    if (channel === 'err') stderr += `${trimmed}\n`
    log(channel === 'err' ? 'stderr' : 'stdout', trimmed)
  }

  const reader = (channel: 'out' | 'err') => {
    let buffer = ''
    return (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n|\r/)
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line, channel)
    }
  }

  child.stdout?.on('data', reader('out'))
  child.stderr?.on('data', reader('err'))

  const result = new Promise<RunResult>((resolve) => {
    child.on('error', (err) => {
      stderr += `${err.message}\n`
      log('spawn-error', err.message)
      flush()
      resolve({ code: null, killed, stderr, filePath })
    })
    child.on('close', (code) => {
      flush()
      resolve({ code, killed, stderr, filePath })
    })
  })

  return {
    child,
    result,
    kill(): void {
      killed = true
      killTree(child)
    }
  }
}
