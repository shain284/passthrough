import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UpscaleItem, UpscaleRequest } from '../shared/types.ts'
import { UPSCALE_DEFAULTS, UPSCALE_FACTORS, VIDEO_EXTENSIONS } from '../shared/types.ts'
import { MediaQueue } from './mediaqueue.ts'
import { isAudioCopied } from './mp4audio.ts'
import { uniqueOutputPath } from './outputs.ts'
import { CHUNK_FRAMES, estimateSeconds, mapUpscaleError, upscaledSize } from './upscale.ts'
import { probeVideoForUpscale, runExtract, runJoin, runSegment, runUpscaleChunk } from './upscalerun.ts'
import type { RunHandle } from './upscalerun.ts'
import { log } from './logger.ts'
import { ensureOutputDir } from './settings.ts'

export function isAcceptableVideoPathForUpscale(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || p.length > 4096) return false
  if (!VIDEO_EXTENSIONS.includes(path.extname(p).toLowerCase())) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * One upscale is a chain of processes rather than a single spawn, so cancelling
 * has to kill whichever one is running right now and stop the chain advancing.
 */
class UpscaleJob {
  private current: RunHandle | null = null
  cancelled = false

  async run(handle: RunHandle): Promise<{ code: number | null; killed: boolean; stderr: string }> {
    if (this.cancelled) {
      handle.kill()
      return { code: null, killed: true, stderr: '' }
    }
    this.current = handle
    try {
      return await handle.result
    } finally {
      this.current = null
    }
  }

  kill(): void {
    this.cancelled = true
    this.current?.kill()
  }
}

class UpscaleQueue extends MediaQueue<UpscaleItem> {
  // One at a time. The GPU is the bottleneck, so running two would just halve
  // each and make both ETAs wrong.
  protected readonly maxConcurrent = 1

  protected retryPatch(): Partial<UpscaleItem> {
    return {
      error: undefined,
      framesDone: undefined,
      measuredFps: undefined,
      etaSeconds: undefined,
      filePath: undefined
    }
  }

  add(req: UpscaleRequest): UpscaleItem[] {
    const factor = UPSCALE_FACTORS.includes(req.factor) ? req.factor : UPSCALE_DEFAULTS.factor

    const created: UpscaleItem[] = []
    for (const inputPath of req.paths) {
      if (!isAcceptableVideoPathForUpscale(inputPath)) continue
      const item: UpscaleItem = {
        id: randomUUID(),
        inputPath,
        fileName: path.basename(inputPath),
        status: 'queued',
        factor,
        createdAt: Date.now()
      }
      this.append(item)
      created.push(item)
      void this.prefill(item.id)
    }

    this.pump()
    return created
  }

  /** Dimensions, length and a first ETA before the job ever starts. */
  private async prefill(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return
    try {
      const info = await probeVideoForUpscale(item.inputPath)
      const current = this.items.get(id)
      if (!current) return
      const out = upscaledSize({ width: info.width, height: info.height }, current.factor)
      this.patch(id, {
        sourceWidth: info.width,
        sourceHeight: info.height,
        outputWidth: out.width,
        outputHeight: out.height,
        durationSeconds: info.durationSeconds,
        frameCount: info.frameCount,
        audioCopied: isAudioCopied(info.audioCodec),
        etaSeconds: estimateSeconds(
          info.frameCount,
          { width: info.width, height: info.height },
          current.factor
        ),
        etaIsEstimate: true
      })
    } catch (e) {
      log('upscale', `probe failed for ${item.inputPath}: ${String(e)}`)
    }
  }

  protected async startItem(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return

    // Claims the slot synchronously; the base counts rows in this state.
    this.patch(id, { status: 'rendering', error: undefined, framesDone: 0 })

    const job = new UpscaleJob()
    const work = path.join(os.tmpdir(), `passthrough-upscale-${id}`)

    this.registerJob(id, {
      kill: () => job.kill(),
      cleanup: async () => {
        await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
    })

    try {
      await this.render(id, job, work)
    } catch (e) {
      if (!job.cancelled) {
        log('upscale', `unexpected failure: ${String(e)}`)
        this.patch(id, {
          status: 'error',
          error: e instanceof Error ? e.message : 'Upscale failed unexpectedly.'
        })
      }
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined)
      this.clearJob(id)
      if (job.cancelled && this.items.has(id)) {
        this.patch(id, { status: 'canceled', framesDone: undefined, etaSeconds: undefined })
      }
      this.pump()
    }
  }

  private async render(id: string, job: UpscaleJob, work: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return

    let outputDir: string
    try {
      outputDir = ensureOutputDir()
    } catch {
      this.patch(id, { status: 'error', error: 'Your output folder is missing. Pick a new one.' })
      return
    }

    const info = await probeVideoForUpscale(item.inputPath).catch((e: unknown) => {
      this.patch(id, {
        status: 'error',
        error: e instanceof Error ? e.message : 'Could not read that video file.'
      })
      return null
    })
    if (!info || job.cancelled) return

    const out = upscaledSize({ width: info.width, height: info.height }, item.factor)
    this.patch(id, {
      sourceWidth: info.width,
      sourceHeight: info.height,
      outputWidth: out.width,
      outputHeight: out.height,
      durationSeconds: info.durationSeconds,
      frameCount: info.frameCount,
      audioCopied: isAudioCopied(info.audioCodec)
    })

    await fsp.mkdir(work, { recursive: true })
    const segments: string[] = []
    const startedAt = Date.now()
    let framesDone = 0

    // Driven by what actually comes out of the decoder rather than by nb_frames,
    // which plenty of containers get wrong or omit entirely.
    for (let index = 0; ; index++) {
      if (job.cancelled) return

      const srcDir = path.join(work, `src${index}`)
      const upDir = path.join(work, `up${index}`)
      await fsp.mkdir(srcDir, { recursive: true })
      await fsp.mkdir(upDir, { recursive: true })

      const extract = await job.run(
        runExtract({
          input: item.inputPath,
          startFrame: index * CHUNK_FRAMES,
          frameCount: CHUNK_FRAMES,
          fps: info.fps,
          outDir: srcDir
        })
      )
      if (job.cancelled) return
      if (extract.code !== 0) {
        this.patch(id, { status: 'error', error: mapUpscaleError(extract.stderr, extract.code) })
        return
      }

      const extracted = (await fsp.readdir(srcDir)).length
      if (extracted === 0) break

      const chunkStartFrames = framesDone
      const upscale = await job.run(
        runUpscaleChunk({
          inDir: srcDir,
          outDir: upDir,
          factor: item.factor,
          onPercent: (pct) => {
            const done = chunkStartFrames + (pct / 100) * extracted
            const elapsed = (Date.now() - startedAt) / 1000
            const fps = elapsed > 1 ? done / elapsed : 0
            const total = Math.max(done, item.frameCount ?? info.frameCount)
            this.patch(id, {
              framesDone: Math.round(done),
              measuredFps: fps > 0 ? fps : undefined,
              etaSeconds: fps > 0.01 ? Math.max(0, (total - done) / fps) : undefined,
              etaIsEstimate: false
            })
          }
        })
      )
      if (job.cancelled) return
      if (upscale.code !== 0) {
        this.patch(id, { status: 'error', error: mapUpscaleError(upscale.stderr, upscale.code) })
        return
      }

      const segment = path.join(work, `seg${String(index).padStart(5, '0')}.mp4`)
      const encode = await job.run(
        runSegment({ frameDir: upDir, fps: info.fps, output: segment })
      )
      if (job.cancelled) return
      if (encode.code !== 0) {
        this.patch(id, { status: 'error', error: mapUpscaleError(encode.stderr, encode.code) })
        return
      }
      segments.push(segment)

      framesDone += extracted
      this.patch(id, { framesDone })

      // Reclaim the frames immediately — this is what bounds scratch space.
      await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => undefined)
      await fsp.rm(upDir, { recursive: true, force: true }).catch(() => undefined)

      // A short chunk means the decoder hit the end of the file.
      if (extracted < CHUNK_FRAMES) break
    }

    if (job.cancelled) return
    if (!segments.length) {
      this.patch(id, { status: 'error', error: 'No frames could be read from that file.' })
      return
    }

    const listFile = path.join(work, 'segments.txt')
    await fsp.writeFile(
      listFile,
      segments.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    )

    const output = await uniqueOutputPath(
      outputDir,
      path.basename(item.inputPath, path.extname(item.inputPath)),
      `(${item.factor}x)`,
      '.mp4'
    )

    const join = await job.run(
      runJoin({
        listFile,
        original: item.inputPath,
        output,
        audioCodec: info.audioCodec
      })
    )
    if (job.cancelled) {
      await fsp.unlink(output).catch(() => undefined)
      return
    }
    if (join.code !== 0 || !fs.existsSync(output)) {
      await fsp.unlink(output).catch(() => undefined)
      this.patch(id, { status: 'error', error: mapUpscaleError(join.stderr, join.code) })
      return
    }

    this.patch(id, {
      status: 'done',
      filePath: output,
      framesDone,
      frameCount: framesDone,
      etaSeconds: 0
    })
  }
}

export const upscaleQueue = new UpscaleQueue()
