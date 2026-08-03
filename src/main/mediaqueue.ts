import { EventEmitter } from 'node:events'

/**
 * Shared machinery for the render tabs (slowed + reverb, aspect stretch): a list
 * of rows, N running at a time, cancel/retry/remove, and an orderly shutdown.
 *
 * Deliberately free of Electron imports so the scheduling can be tested directly.
 * The download queue is not built on this — it has its own states (downloading,
 * processing) and a synchronous start.
 */

export type QueueStatus = 'queued' | 'rendering' | 'done' | 'error' | 'canceled'

export interface QueueItem {
  id: string
  status: QueueStatus
}

export interface QueueJob {
  /** Kill the child process. */
  kill(): void
  /** Wait for it to die, then remove whatever partial output it wrote. */
  cleanup(): Promise<void>
}

export abstract class MediaQueue<T extends QueueItem> extends EventEmitter {
  protected readonly items = new Map<string, T>()
  protected readonly jobs = new Map<string, QueueJob>()
  protected order: string[] = []

  protected abstract readonly maxConcurrent: number

  /** Fields to clear when a row goes back in the queue. */
  protected abstract retryPatch(item: T): Partial<T>

  /**
   * Begin one row. Must move it out of `queued` synchronously — otherwise pump()
   * cannot tell the slot was taken and would start the same row forever.
   */
  protected abstract startItem(id: string): void | Promise<void>

  list(): T[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((i): i is T => i !== undefined)
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  protected patch(id: string, patch: Partial<T>): void {
    const item = this.items.get(id)
    if (!item) return
    Object.assign(item, patch)
    this.emit('update', item)
  }

  /** Newest first, which is the order the UI shows. */
  protected append(item: T): void {
    this.items.set(item.id, item)
    this.order.unshift(item.id)
    this.emit('update', item)
  }

  protected registerJob(id: string, job: QueueJob): void {
    this.jobs.set(id, job)
  }

  protected clearJob(id: string): void {
    this.jobs.delete(id)
  }

  /**
   * Rows holding a slot — which is not the same as spawned children. A render
   * claims its slot while it is still probing, before ffmpeg exists, so counting
   * live processes here would let the whole queue start at once.
   */
  protected inFlight(): number {
    let n = 0
    for (const item of this.items.values()) {
      if (item.status === 'rendering') n++
    }
    return n
  }

  protected pump(): void {
    for (;;) {
      if (this.inFlight() >= this.maxConcurrent) return

      // Oldest queued first; `order` is newest-first for display.
      const next = [...this.order]
        .reverse()
        .map((id) => this.items.get(id))
        .find((i) => i?.status === 'queued')
      if (!next) return

      void this.startItem(next.id)

      // A startItem that leaves the row queued would spin this loop forever.
      if (this.items.get(next.id)?.status === 'queued') return
    }
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    if (!item) return

    const job = this.jobs.get(id)
    if (job) {
      // The finish path flips the status and cleans up after the process dies.
      job.kill()
      return
    }

    if (item.status === 'queued' || item.status === 'rendering') {
      // 'rendering' with no job means it claimed a slot but has not spawned yet;
      // the start path re-checks status before launching anything.
      this.patch(id, { status: 'canceled' } as Partial<T>)
      this.pump()
    }
  }

  retry(id: string): void {
    const item = this.items.get(id)
    if (!item || item.status === 'rendering') return
    this.patch(id, { ...this.retryPatch(item), status: 'queued' } as Partial<T>)
    this.pump()
  }

  remove(id: string): void {
    const job = this.jobs.get(id)
    if (job) job.kill()
    this.items.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.emit('removed', id)
    this.pump()
  }

  hasActive(): boolean {
    return this.jobs.size > 0 || this.inFlight() > 0
  }

  /** Called on quit: kill everything and take the partial files with it. */
  async shutdown(): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const [, job] of this.jobs) {
      job.kill()
      pending.push(job.cleanup().catch(() => undefined))
    }
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 4000))])
  }
}
