import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { FormatId } from '@shared/types'
import { ffmpegDir, jsRuntimeArgs, spawnEnv, ytDlpPath } from './binaries.ts'
import { FILE_PREFIX, POSTPROCESS_PREFIX, PROGRESS_PREFIX, buildDownloadArgs } from './formats.ts'
import { log } from './logger.ts'
import { killTree } from './proc.ts'
import { parseProgressLine } from './progress.ts'
import type { ProgressUpdate } from './progress.ts'

export type { ProgressUpdate }

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

/**
 * Spawns yt-dlp for one download. Args are always an array — no shell, no string
 * interpolation, and the URL is passed after `--`.
 */
export function runDownload(opts: RunOptions): RunHandle {
  const args = buildDownloadArgs({
    url: opts.url,
    format: opts.format,
    outputDir: opts.outputDir,
    ffmpegDir,
    extraArgs: jsRuntimeArgs(),
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
      const p = parseProgressLine(trimmed)
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
