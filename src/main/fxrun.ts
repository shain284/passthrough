import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ffmpegPath, ffprobePath, spawnEnv } from './binaries.ts'
import { buildFxArgs, parseFfmpegProgress } from './audiofx.ts'
import { log } from './logger.ts'
import { killTree } from './proc.ts'

/**
 * Everything in the slowed + reverb path that actually spawns a process.
 * audiofx.ts stays free of Electron so the filter and parsing logic can be
 * exercised directly by the tests, the same way formats.ts is.
 */

export interface AudioInfo {
  durationSeconds: number
  sampleRate: number
}

export function probeAudio(file: string): Promise<AudioInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate',
        '-show_entries', 'format=duration',
        '-of', 'json',
        '--', file
      ],
      { timeout: 30000, windowsHide: true, env: spawnEnv(), maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || 'Could not read that audio file.'))
          return
        }
        try {
          const json = JSON.parse(stdout) as {
            streams?: { sample_rate?: string }[]
            format?: { duration?: string }
          }
          const stream = json.streams?.[0]
          if (!stream) {
            reject(new Error('That file has no audio stream.'))
            return
          }
          const sampleRate = Number(stream.sample_rate)
          const durationSeconds = Number(json.format?.duration)
          resolve({
            sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100,
            durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0
          })
        } catch {
          reject(new Error('Could not read that audio file.'))
        }
      }
    )
  })
}

export interface FxRunOptions {
  input: string
  output: string
  sampleRate: number
  speed: number
  reverb: number
  onProgress(outSeconds: number): void
}

export interface FxRunResult {
  code: number | null
  killed: boolean
  stderr: string
}

export interface FxRunHandle {
  result: Promise<FxRunResult>
  kill(): void
}

export function runFx(opts: FxRunOptions): FxRunHandle {
  const args = buildFxArgs(opts)
  log('fx-spawn', `${ffmpegPath} ${args.join(' ')}`)

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
      if (now - lastEmit < 100) continue // ~10 updates/sec, same as downloads
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
      log('fx-stderr', line)
    }
  })

  const result = new Promise<FxRunResult>((resolve) => {
    child.on('error', (err) => {
      stderr += `${err.message}\n`
      log('fx-spawn-error', err.message)
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
