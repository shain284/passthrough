import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ffmpegPath, ffprobePath, spawnEnv } from './binaries.ts'
import { parseFfmpegProgress } from './ffprogress.ts'
import { buildStretchArgs } from './stretch.ts'
import type { StretchArgsOptions } from './stretch.ts'
import { log } from './logger.ts'
import { killTree } from './proc.ts'

export interface VideoInfo {
  width: number
  height: number
  durationSeconds: number
  audioCodec: string | null
}

export function probeVideo(file: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,codec_name,width,height',
        '-show_entries', 'format=duration',
        '-of', 'json',
        '--', file
      ],
      { timeout: 30000, windowsHide: true, env: spawnEnv(), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || 'Could not read that video file.'))
          return
        }
        try {
          const json = JSON.parse(stdout) as {
            streams?: {
              codec_type?: string
              codec_name?: string
              width?: number
              height?: number
            }[]
            format?: { duration?: string }
          }
          const streams = json.streams ?? []
          const video = streams.find((s) => s.codec_type === 'video')
          const audio = streams.find((s) => s.codec_type === 'audio')

          if (!video || !video.width || !video.height) {
            reject(new Error('That file has no video stream.'))
            return
          }

          const duration = Number(json.format?.duration)
          resolve({
            width: video.width,
            height: video.height,
            durationSeconds: Number.isFinite(duration) ? duration : 0,
            audioCodec: audio?.codec_name ?? null
          })
        } catch {
          reject(new Error('Could not read that video file.'))
        }
      }
    )
  })
}

export interface StretchRunOptions extends StretchArgsOptions {
  onProgress(outSeconds: number): void
}

export interface StretchRunResult {
  code: number | null
  killed: boolean
  stderr: string
}

export interface StretchRunHandle {
  result: Promise<StretchRunResult>
  kill(): void
}

export function runStretch(opts: StretchRunOptions): StretchRunHandle {
  const args = buildStretchArgs(opts)
  log('stretch-spawn', `${ffmpegPath} ${args.join(' ')}`)

  const child: ChildProcess = spawn(ffmpegPath, args, {
    windowsHide: true,
    env: spawnEnv(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let killed = false
  let stderr = ''
  let lastEmit = 0

  let outBuf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    outBuf += chunk.toString('utf8')
    const lines = outBuf.split(/\r?\n/)
    outBuf = lines.pop() ?? ''
    for (const line of lines) {
      const seconds = parseFfmpegProgress(line)
      if (seconds === null) continue
      const now = Date.now()
      if (now - lastEmit < 100) continue // ~10 updates/sec, same as the other tabs
      lastEmit = now
      opts.onProgress(seconds)
    }
  })

  let errBuf = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    errBuf += chunk.toString('utf8')
    const lines = errBuf.split(/\r?\n/)
    errBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      stderr += `${line}\n`
      log('stretch-stderr', line)
    }
  })

  const result = new Promise<StretchRunResult>((resolve) => {
    child.on('error', (err) => {
      stderr += `${err.message}\n`
      log('stretch-spawn-error', err.message)
      resolve({ code: null, killed, stderr })
    })
    child.on('close', (code) => {
      if (errBuf.trim()) stderr += `${errBuf}\n`
      resolve({ code, killed, stderr })
    })
  })

  return {
    result,
    kill(): void {
      killed = true
      killTree(child)
    }
  }
}
