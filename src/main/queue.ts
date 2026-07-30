import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { DownloadItem, StartRequest } from '@shared/types'
import { runDownload } from './download'
import type { RunHandle } from './download'
import { isRemuxFailure, mapError } from './errors'
import { fetchMeta } from './metadata'
import { cleanupPartials } from './proc'
import { ensureOutputDir, getSettings } from './settings'
import { log } from './logger'
import { normalizeUrl } from './urls'

const MAX_CONCURRENT = 2

interface JobRecord {
  handle: RunHandle
  outputDir: string
  startedAt: number
  /** Set while we are retrying a failed mp4 remux as an mkv keep. */
  remuxRetried: boolean
}

/**
 * Owns every download row and every child process. Two run at a time; the rest
 * sit in `queued` until a slot frees up.
 */
class DownloadQueue extends EventEmitter {
  private items = new Map<string, DownloadItem>()
  private jobs = new Map<string, JobRecord>()
  private order: string[] = []

  list(): DownloadItem[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((i): i is DownloadItem => i !== undefined)
  }

  get(id: string): DownloadItem | undefined {
    return this.items.get(id)
  }

  private patch(id: string, patch: Partial<DownloadItem>): void {
    const item = this.items.get(id)
    if (!item) return
    Object.assign(item, patch)
    this.emit('update', item)
  }

  add(req: StartRequest): DownloadItem {
    const url = normalizeUrl(req.url)
    if (!url) throw new Error('That link is not a supported YouTube or TikTok URL.')

    const item: DownloadItem = {
      id: randomUUID(),
      url,
      format: req.format,
      status: 'queued',
      useCookies: req.useCookies,
      videoId: req.meta?.id || undefined,
      title: req.meta?.title || url,
      thumbnail: req.meta?.thumbnail,
      duration: req.meta?.duration,
      uploader: req.meta?.uploader,
      createdAt: Date.now()
    }

    this.items.set(item.id, item)
    this.order.unshift(item.id)
    this.emit('update', item)

    // The row was created before metadata arrived (paste-and-go). Backfill it.
    if (!req.meta) void this.backfillMeta(item.id)

    this.pump()
    return item
  }

  private async backfillMeta(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return
    try {
      const meta = await fetchMeta(item.url, item.useCookies)
      const current = this.items.get(id)
      if (!current || current.status === 'canceled') return
      this.patch(id, {
        videoId: meta.id || current.videoId,
        title: meta.title || current.title,
        thumbnail: meta.thumbnail ?? current.thumbnail,
        duration: meta.duration ?? current.duration,
        uploader: meta.uploader ?? current.uploader
      })
    } catch (e) {
      log('meta', `backfill failed for ${item.url}: ${String(e)}`)
    }
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    if (!item) return

    const job = this.jobs.get(id)
    if (job) {
      job.handle.kill()
      // close handler does the cleanup and status flip.
      return
    }

    if (item.status === 'queued') {
      this.patch(id, { status: 'canceled', speed: undefined, eta: undefined })
      this.pump()
    }
  }

  retry(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    if (item.status === 'downloading' || item.status === 'processing') return

    this.patch(id, {
      status: 'queued',
      // Pick up the cookie toggle as it stands now, so "Use cookies & retry" works.
      useCookies: getSettings().useCookies,
      error: undefined,
      note: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      totalIsEstimate: undefined,
      speed: undefined,
      eta: undefined,
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

  setCookiePreference(useCookies: boolean): void {
    for (const item of this.items.values()) {
      if (item.status === 'queued') this.patch(item.id, { useCookies })
    }
  }

  private pump(): void {
    if (this.jobs.size >= MAX_CONCURRENT) return
    // Oldest queued first — `order` is newest-first for display.
    const next = [...this.order]
      .reverse()
      .map((id) => this.items.get(id))
      .find((i) => i?.status === 'queued')
    if (!next) return

    this.start(next.id)
    if (this.jobs.size < MAX_CONCURRENT) this.pump()
  }

  private start(id: string, keepMkv = false): void {
    const item = this.items.get(id)
    if (!item) return

    let outputDir: string
    try {
      outputDir = ensureOutputDir()
    } catch {
      this.patch(id, {
        status: 'error',
        error: { message: 'Your download folder is missing. Pick a new one.', action: 'none' }
      })
      return
    }

    const startedAt = Date.now()
    this.patch(id, {
      status: 'downloading',
      error: undefined,
      downloadedBytes: 0,
      speed: undefined,
      eta: undefined
    })

    const handle = runDownload({
      url: item.url,
      format: item.format,
      outputDir,
      useCookies: item.useCookies,
      keepMkv,
      onProgress: (p) => {
        const current = this.items.get(id)
        if (!current || (current.status !== 'downloading' && current.status !== 'processing')) return
        // A second stream starting (video then audio) means we are downloading again.
        this.patch(id, { ...p, status: 'downloading' })
      },
      onProcessing: () => {
        const current = this.items.get(id)
        if (!current || current.status !== 'downloading') return
        this.patch(id, { status: 'processing', speed: undefined, eta: undefined })
      }
    })

    const existing = this.jobs.get(id)
    this.jobs.set(id, {
      handle,
      outputDir,
      startedAt,
      remuxRetried: existing?.remuxRetried ?? keepMkv
    })

    void handle.result.then((result) => this.finish(id, result, outputDir, startedAt))
  }

  private async finish(
    id: string,
    result: Awaited<RunHandle['result']>,
    outputDir: string,
    startedAt: number
  ): Promise<void> {
    const record = this.jobs.get(id)
    this.jobs.delete(id)

    const item = this.items.get(id)
    if (!item) {
      await cleanupPartials(outputDir, undefined, startedAt)
      this.pump()
      return
    }

    if (result.killed) {
      this.patch(id, {
        status: 'canceled',
        speed: undefined,
        eta: undefined,
        downloadedBytes: undefined
      })
      await cleanupPartials(outputDir, item.videoId, startedAt)
      this.pump()
      return
    }

    if (result.code === 0) {
      const filePath = result.filePath && fs.existsSync(result.filePath) ? result.filePath : undefined
      this.patch(id, {
        status: 'done',
        filePath,
        speed: undefined,
        eta: undefined,
        downloadedBytes: item.totalBytes ?? item.downloadedBytes
      })
      // Leftover .fNNN intermediates when yt-dlp is interrupted between merge steps.
      await cleanupPartials(outputDir, item.videoId, startedAt)
      this.pump()
      return
    }

    // The mp4 remux is a stream copy; if the streams will not sit in an mp4
    // container we keep the mkv rather than re-encoding anything.
    if (
      item.format === 'mp4' &&
      record &&
      !record.remuxRetried &&
      isRemuxFailure(result.stderr)
    ) {
      log('remux', `mp4 remux refused for ${item.url}; retrying as mkv`)
      await cleanupPartials(outputDir, item.videoId, startedAt)
      this.patch(id, {
        note: 'These streams will not fit in an MP4 container, so this is being kept as MKV — no re-encode.'
      })
      this.start(id, true)
      return
    }

    this.patch(id, {
      status: 'error',
      error: mapError(result.stderr, result.code),
      speed: undefined,
      eta: undefined
    })
    await cleanupPartials(outputDir, item.videoId, startedAt)
    this.pump()
  }

  /** Called on window close so we never leave orphaned children or .part files. */
  async shutdown(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [id, job] of this.jobs) {
      const item = this.items.get(id)
      job.handle.kill()
      pending.push(
        job.handle.result
          .then(() => cleanupPartials(job.outputDir, item?.videoId, job.startedAt))
          .catch(() => undefined)
      )
    }
    await Promise.race([
      Promise.all(pending),
      new Promise((r) => setTimeout(r, 4000))
    ])
  }

  hasActive(): boolean {
    return this.jobs.size > 0
  }
}

export const queue = new DownloadQueue()
