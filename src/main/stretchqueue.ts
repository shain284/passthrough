import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StretchItem, StretchRequest } from '../shared/types.ts'
import { ASPECT_IDS, FIT_MODE_IDS, STRETCH_DEFAULTS, VIDEO_EXTENSIONS } from '../shared/types.ts'
import { MediaQueue } from './mediaqueue.ts'
import { uniqueOutputPath } from './outputs.ts'
import { isAudioCopied, mapStretchError, outputSize } from './stretch.ts'
import { probeVideo, runStretch } from './stretchrun.ts'
import { log } from './logger.ts'
import { ensureOutputDir } from './settings.ts'

/** Rejects anything that is not a readable file with a video extension. */
export function isAcceptableVideoPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || p.length > 4096) return false
  if (!VIDEO_EXTENSIONS.includes(path.extname(p).toLowerCase())) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

class StretchQueue extends MediaQueue<StretchItem> {
  protected readonly maxConcurrent = 2

  protected retryPatch(): Partial<StretchItem> {
    return {
      error: undefined,
      renderedSeconds: undefined,
      filePath: undefined
    }
  }

  add(req: StretchRequest): StretchItem[] {
    const aspect = ASPECT_IDS.includes(req.aspect) ? req.aspect : STRETCH_DEFAULTS.aspect
    const mode = FIT_MODE_IDS.includes(req.mode) ? req.mode : STRETCH_DEFAULTS.mode

    const created: StretchItem[] = []
    for (const inputPath of req.paths) {
      if (!isAcceptableVideoPath(inputPath)) continue

      const item: StretchItem = {
        id: randomUUID(),
        inputPath,
        fileName: path.basename(inputPath),
        status: 'queued',
        aspect,
        mode,
        createdAt: Date.now()
      }
      this.append(item)
      created.push(item)

      void this.prefill(item.id)
    }

    this.pump()
    return created
  }

  /** Dimensions and length up front, so the row is informative before it runs. */
  private async prefill(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return
    try {
      const info = await probeVideo(item.inputPath)
      const current = this.items.get(id)
      if (!current) return
      const out = outputSize({ width: info.width, height: info.height }, current.aspect)
      this.patch(id, {
        sourceWidth: info.width,
        sourceHeight: info.height,
        outputWidth: out.width,
        outputHeight: out.height,
        durationSeconds: info.durationSeconds,
        audioCopied: isAudioCopied(info.audioCodec)
      })
    } catch (e) {
      log('stretch', `probe failed for ${item.inputPath}: ${String(e)}`)
    }
  }

  protected async startItem(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return

    // Claims the slot synchronously; the base counts rows in this state, not
    // spawned children, so the awaits below cannot oversubscribe the queue.
    this.patch(id, { status: 'rendering', error: undefined, renderedSeconds: 0 })

    let outputDir: string
    try {
      outputDir = ensureOutputDir()
    } catch {
      this.patch(id, { status: 'error', error: 'Your output folder is missing. Pick a new one.' })
      this.pump()
      return
    }

    let info: Awaited<ReturnType<typeof probeVideo>>
    try {
      info = await probeVideo(item.inputPath)
    } catch (e) {
      this.patch(id, {
        status: 'error',
        error: e instanceof Error ? e.message : 'Could not read that video file.'
      })
      this.pump()
      return
    }

    if (this.items.get(id)?.status !== 'rendering') return // canceled while probing

    const out = outputSize({ width: info.width, height: info.height }, item.aspect)
    const output = await uniqueOutputPath(
      outputDir,
      path.basename(item.inputPath, path.extname(item.inputPath)),
      `(${item.aspect.replace(':', 'x')})`,
      '.mp4'
    )

    if (this.items.get(id)?.status !== 'rendering') return

    this.patch(id, {
      sourceWidth: info.width,
      sourceHeight: info.height,
      outputWidth: out.width,
      outputHeight: out.height,
      durationSeconds: info.durationSeconds,
      audioCopied: isAudioCopied(info.audioCodec)
    })

    const handle = runStretch({
      input: item.inputPath,
      output,
      source: { width: info.width, height: info.height },
      aspect: item.aspect,
      mode: item.mode,
      audioCodec: info.audioCodec,
      onProgress: (seconds) => {
        if (this.items.get(id)?.status !== 'rendering') return
        this.patch(id, { renderedSeconds: seconds })
      }
    })

    this.registerJob(id, {
      kill: () => handle.kill(),
      cleanup: async () => {
        await handle.result
        await fsp.unlink(output).catch(() => undefined)
      }
    })

    void handle.result.then((result) => this.finish(id, result, output))
  }

  private async finish(
    id: string,
    result: Awaited<ReturnType<typeof runStretch>['result']>,
    output: string
  ): Promise<void> {
    this.clearJob(id)

    const removePartial = async (): Promise<void> => {
      await fsp.unlink(output).catch(() => undefined)
    }

    if (!this.items.has(id)) {
      await removePartial()
      this.pump()
      return
    }

    if (result.killed) {
      await removePartial()
      this.patch(id, { status: 'canceled', renderedSeconds: undefined })
      this.pump()
      return
    }

    if (result.code === 0 && fs.existsSync(output)) {
      const item = this.items.get(id)
      this.patch(id, {
        status: 'done',
        filePath: output,
        renderedSeconds: item?.durationSeconds
      })
      this.pump()
      return
    }

    await removePartial()
    this.patch(id, {
      status: 'error',
      error: mapStretchError(result.stderr, result.code),
      renderedSeconds: undefined
    })
    this.pump()
  }
}

export const stretchQueue = new StretchQueue()
