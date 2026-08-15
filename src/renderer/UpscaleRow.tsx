import type { UpscaleItem } from '../shared/types.ts'
import { duration } from './format.ts'

const STATUS_LABELS: Record<UpscaleItem['status'], string> = {
  queued: 'Queued',
  rendering: 'Upscaling',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled'
}

interface Props {
  item: UpscaleItem
  onCancel(id: string): void
  onRetry(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
}

function fileName(p: string | undefined): string | undefined {
  if (!p) return undefined
  return p.split(/[\\/]/).pop()
}

/** Hours matter here in a way they never do on the other tabs. */
export function longDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function UpscaleRow({
  item,
  onCancel,
  onRetry,
  onRemove,
  onShow
}: Props): React.JSX.Element {
  const active = item.status === 'rendering'
  const total = item.frameCount ?? 0
  const known = total > 0
  const pct = known ? Math.min(100, ((item.framesDone ?? 0) / total) * 100) : 0

  const barClass = [
    'bar',
    item.status === 'done' ? 'bar-done' : '',
    item.status === 'error' ? 'bar-error' : '',
    item.status === 'canceled' ? 'bar-canceled' : '',
    active && !known ? 'bar-indeterminate' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const sizes =
    item.sourceWidth && item.outputWidth
      ? `${item.sourceWidth}×${item.sourceHeight} → ${item.outputWidth}×${item.outputHeight}`
      : undefined

  let detail: React.JSX.Element | string = ''
  if (item.status === 'rendering') {
    const parts: string[] = []
    if (known) parts.push(`${item.framesDone ?? 0} of ${total} frames`)
    if (item.measuredFps) parts.push(`${item.measuredFps.toFixed(1)} fps`)
    if (item.etaSeconds !== undefined && item.etaSeconds > 0) {
      parts.push(`${longDuration(item.etaSeconds)} left`)
    }
    detail = parts.join(' · ') || 'Starting…'
  } else if (item.status === 'queued') {
    detail =
      item.etaSeconds !== undefined
        ? `Waiting — roughly ${longDuration(item.etaSeconds)} of work`
        : 'Waiting for the GPU'
  } else if (item.status === 'done') {
    detail = fileName(item.filePath) ?? 'Saved'
  } else if (item.status === 'error') {
    detail = <span className="detail-error">{item.error ?? 'Upscale failed.'}</span>
  } else if (item.status === 'canceled') {
    detail = 'Canceled — scratch files removed'
  }

  return (
    <li className={`row row-${item.status}`}>
      <div className="upscale-glyph" aria-hidden="true">
        {item.factor}×
      </div>

      <div className="row-body">
        <div className="row-title" title={item.inputPath}>
          {item.fileName}
        </div>

        <div className="row-meta">
          <span className="badge">{item.factor}× Real-ESRGAN</span>
          <span className={`status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
          {sizes ? <span className="dim">{sizes}</span> : null}
          {item.durationSeconds ? (
            <span className="dim">{duration(item.durationSeconds)}</span>
          ) : null}
        </div>

        <div className="track">
          <div
            className={barClass}
            style={
              known || !active ? { width: `${item.status === 'done' ? 100 : pct}%` } : undefined
            }
          />
        </div>

        <div className="row-detail">{detail}</div>

        {item.audioCopied === false && item.status !== 'error' ? (
          <div className="row-note">
            That audio codec cannot sit in an MP4, so the audio is being converted to AAC.
          </div>
        ) : null}
      </div>

      <div className="row-actions">
        {active || item.status === 'queued' ? (
          <button className="btn btn-quiet" onClick={() => onCancel(item.id)}>
            Cancel
          </button>
        ) : null}

        {item.status === 'done' ? (
          <button className="btn btn-quiet" onClick={() => onShow(item.id)}>
            Show in folder
          </button>
        ) : null}

        {item.status === 'error' || item.status === 'canceled' ? (
          <button className="btn btn-quiet" onClick={() => onRetry(item.id)}>
            Retry
          </button>
        ) : null}

        {!active ? (
          <button
            className="btn btn-icon"
            title="Remove from list"
            aria-label="Remove from list"
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        ) : null}
      </div>
    </li>
  )
}
