import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FxItem, FxRequest } from '../shared/types.ts'
import { FX_EXTENSIONS } from '../shared/types.ts'
import { clampReverb, clampSpeed, expectedDuration, mapFxError } from './audiofx.ts'
import { probeAudio, runFx } from './fxrun.ts'
import type { FxRunHandle } from './fxrun.ts'
import { log } from './logger.ts'
import { ensureOutputDir } from './settings.ts'

const MAX_CONCURRENT = 2

interface FxJob {
  handle: FxRunHandle
  output: string
}

/** Rejects anything that is not a readable file with an audio extension. */
export function isAcceptableAudioPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || p.length > 4096) return false
  if (!FX_EXTENSIONS.includes(path.extname(p).toLowerCase())) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Picks a name that does not already exist, so re-rendering the same track with
 * different settings never silently destroys the previous result.
 */
async function uniqueOutputPath(dir: string, base: string): Promise<string> {
  const stem = `${base} (slowed + reverb)`
  for (let n = 0; n < 500; n++) {
    const name = n === 0 ? `${stem}.mp3` : `${stem} ${n + 1}.mp3`
    const candidate = path.join(dir, name)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem} ${randomUUID().slice(0, 8)}.mp3`)
}

class FxQueue extends EventEmitter {
  private items = new Map<string, FxItem>()
  private jobs = new Map<string, FxJob>()
  private order: string[] = []

  list(): FxItem[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((i): i is FxItem => i !== undefined)
  }

  get(id: string): FxItem | undefined {
    return this.items.get(id)
  }

  private patch(id: string, patch: Partial<FxItem>): void {
    const item = this.items.get(id)
    if (!item) return
    Object.assign(item, patch)
    this.emit('update', item)
  }

  add(req: FxRequest): FxItem[] {
    const speed = clampSpeed(req.speed)
    const reverb = clampReverb(req.reverb)

    const created: FxItem[] = []
    for (const inputPath of req.paths) {
      if (!isAcceptableAudioPath(inputPath)) continue

      const item: FxItem = {
        id: randomUUID(),
        inputPath,
        fileName: path.basename(inputPath),
        status: 'queued',
        speed,
        reverb,
        createdAt: Date.now()
      }
      this.items.set(item.id, item)
      this.order.unshift(item.id)
      this.emit('update', item)
      created.push(item)

      void this.probe(item.id)
    }

    this.pump()
    return created
  }

  /** Length is needed before the bar can mean anything. */
  private async probe(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return
    try {
      const info = await probeAudio(item.inputPath)
      const current = this.items.get(id)
      if (!current) return
      this.patch(id, {
        durationIn: info.durationSeconds,
        durationOut: expectedDuration(info.durationSeconds, current.speed)
      })
    } catch (e) {
      log('fx', `probe failed for ${item.inputPath}: ${String(e)}`)
    }
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    const job = this.jobs.get(id)
    if (job) {
      job.handle.kill()
      return
    }
    if (item.status === 'queued') {
      this.patch(id, { status: 'canceled' })
      this.pump()
    }
  }

  retry(id: string): void {
    const item = this.items.get(id)
    if (!item || item.status === 'rendering') return
    this.patch(id, {
      status: 'queued',
      error: undefined,
      renderedSeconds: undefined,
      filePath: undefined
    })
    this.pump()
  }

  remove(id: string): void {
    const job = this.jobs.get(id)
    if (job) job.handle.kill()
    this.items.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.emit('removed', id)
    this.pump()
  }

  private pump(): void {
    if (this.jobs.size >= MAX_CONCURRENT) return
    const next = [...this.order]
      .reverse()
      .map((id) => this.items.get(id))
      .find((i) => i?.status === 'queued')
    if (!next) return

    void this.start(next.id)
    if (this.jobs.size < MAX_CONCURRENT) this.pump()
  }

  private async start(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return

    // Claim the slot before the first await, or pump() will oversubscribe.
    this.patch(id, { status: 'rendering', error: undefined, renderedSeconds: 0 })

    let outputDir: string
    try {
      outputDir = ensureOutputDir()
    } catch {
      this.patch(id, { status: 'error', error: 'Your output folder is missing. Pick a new one.' })
      this.pump()
      return
    }

    let info: { sampleRate: number; durationSeconds: number }
    try {
      info = await probeAudio(item.inputPath)
    } catch (e) {
      this.patch(id, {
        status: 'error',
        error: e instanceof Error ? e.message : 'Could not read that audio file.'
      })
      this.pump()
      return
    }

    if (this.items.get(id)?.status !== 'rendering') return // canceled while probing

    const output = await uniqueOutputPath(
      outputDir,
      path.basename(item.inputPath, path.extname(item.inputPath))
    )

    this.patch(id, {
      durationIn: info.durationSeconds,
      durationOut: expectedDuration(info.durationSeconds, item.speed)
    })

    const handle = runFx({
      input: item.inputPath,
      output,
      sampleRate: info.sampleRate,
      speed: item.speed,
      reverb: item.reverb,
      onProgress: (seconds) => {
        if (this.items.get(id)?.status !== 'rendering') return
        this.patch(id, { renderedSeconds: seconds })
      }
    })

    this.jobs.set(id, { handle, output })
    void handle.result.then((result) => this.finish(id, result, output))
  }

  private async finish(
    id: string,
    result: Awaited<FxRunHandle['result']>,
    output: string
  ): Promise<void> {
    this.jobs.delete(id)

    const removePartial = async (): Promise<void> => {
      try {
        await fsp.unlink(output)
      } catch {
        /* never existed, or already gone */
      }
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
        renderedSeconds: item?.durationOut
      })
      this.pump()
      return
    }

    await removePartial()
    this.patch(id, {
      status: 'error',
      error: mapFxError(result.stderr, result.code),
      renderedSeconds: undefined
    })
    this.pump()
  }

  async shutdown(): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const [, job] of this.jobs) {
      job.handle.kill()
      pending.push(
        job.handle.result
          .then(() => fsp.unlink(job.output).catch(() => undefined))
          .catch(() => undefined)
      )
    }
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 4000))])
  }

  hasActive(): boolean {
    return this.jobs.size > 0
  }
}

export const fxQueue = new FxQueue()
