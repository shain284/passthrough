import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { UpscaleFactor } from '../shared/types.ts'
import { ffmpegPath, ffprobePath, modelsDir, realesrganPath, spawnEnv } from './binaries.ts'
import { log } from './logger.ts'
import { killTree } from './proc.ts'
import {
  buildExtractArgs,
  buildJoinArgs,
  buildSegmentArgs,
  buildUpscaleArgs,
  parseUpscalePercent
} from './upscale.ts'

/**
 * The spawning half of the upscaler. Each helper runs one process to completion
 * and resolves; the queue drives them chunk by chunk so a cancel can land
 * between steps rather than only at the end of a multi-hour render.
 */

export interface RunHandle {
  result: Promise<{ code: number | null; killed: boolean; stderr: string }>
  kill(): void
}

function runProcess(
  file: string,
  args: string[],
  scope: string,
  onStderrLine?: (line: string) => void
): RunHandle {
  log(`${scope}-spawn`, `${file} ${args.join(' ')}`)

  const child: ChildProcess = spawn(file, args, {
    windowsHide: true,
    env: spawnEnv(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let killed = false
  let stderr = ''
  let buf = ''

  const consume = (chunk: Buffer): void => {
    buf += chunk.toString('utf8')
    // Real-ESRGAN rewrites its percentage with \r, so split on both.
    const lines = buf.split(/\r?\n|\r/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      onStderrLine?.(line)
      // Percentages are noise in the log; everything else might be the failure.
      if (parseUpscalePercent(line) === null) {
        stderr += `${line}\n`
        log(`${scope}-stderr`, line)
      }
    }
  }

  child.stderr?.on('data', consume)
  child.stdout?.on('data', consume)

  const result = new Promise<{ code: number | null; killed: boolean; stderr: string }>(
    (resolve) => {
      child.on('error', (err) => {
        stderr += `${err.message}\n`
        log(`${scope}-spawn-error`, err.message)
        resolve({ code: null, killed, stderr })
      })
      child.on('close', (code) => {
        if (buf.trim() && parseUpscalePercent(buf) === null) stderr += `${buf}\n`
        resolve({ code, killed, stderr })
      })
    }
  )

  return {
    result,
    kill(): void {
      killed = true
      killTree(child)
    }
  }
}

export interface VideoInfo {
  width: number
  height: number
  durationSeconds: number
  fps: number
  frameCount: number
  audioCodec: string | null
}

export function probeVideoForUpscale(file: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames',
        '-show_entries', 'format=duration',
        '-of', 'json',
        '--', file
      ],
      { timeout: 60000, windowsHide: true, env: spawnEnv(), maxBuffer: 4 * 1024 * 1024 },
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
              r_frame_rate?: string
              nb_frames?: string
            }[]
            format?: { duration?: string }
          }
          const streams = json.streams ?? []
          const video = streams.find((s) => s.codec_type === 'video')
          const audio = streams.find((s) => s.codec_type === 'audio')
          if (!video?.width || !video.height) {
            reject(new Error('That file has no video stream.'))
            return
          }

          const [num, den] = (video.r_frame_rate ?? '0/1').split('/').map(Number)
          const fps = den ? num / den : 0
          const duration = Number(json.format?.duration)
          const durationSeconds = Number.isFinite(duration) ? duration : 0

          // nb_frames is absent on plenty of containers; derive it when it is.
          const declared = Number(video.nb_frames)
          const frameCount =
            Number.isFinite(declared) && declared > 0
              ? declared
              : Math.max(1, Math.round(durationSeconds * fps))

          resolve({
            width: video.width,
            height: video.height,
            durationSeconds,
            fps: fps > 0 ? fps : 24,
            frameCount,
            audioCodec: audio?.codec_name ?? null
          })
        } catch {
          reject(new Error('Could not read that video file.'))
        }
      }
    )
  })
}

export function runExtract(opts: {
  input: string
  startFrame: number
  frameCount: number
  fps: number
  outDir: string
}): RunHandle {
  return runProcess(ffmpegPath, buildExtractArgs(opts), 'up-extract')
}

export function runUpscaleChunk(opts: {
  inDir: string
  outDir: string
  factor: UpscaleFactor
  onPercent(pct: number): void
}): RunHandle {
  return runProcess(
    realesrganPath,
    buildUpscaleArgs({
      inDir: opts.inDir,
      outDir: opts.outDir,
      factor: opts.factor,
      modelDir: modelsDir
    }),
    'up-model',
    (line) => {
      const pct = parseUpscalePercent(line)
      if (pct !== null) opts.onPercent(pct)
    }
  )
}

export function runSegment(opts: {
  frameDir: string
  fps: number
  output: string
}): RunHandle {
  return runProcess(ffmpegPath, buildSegmentArgs(opts), 'up-segment')
}

export function runJoin(opts: {
  listFile: string
  original: string
  output: string
  audioCodec: string | null
}): RunHandle {
  return runProcess(ffmpegPath, buildJoinArgs(opts), 'up-join')
}
