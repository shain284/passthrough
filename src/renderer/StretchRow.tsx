import type { StretchItem } from '../shared/types.ts'
import { ASPECTS, FIT_MODES } from '../shared/types.ts'
import { duration } from './format.ts'

const STATUS_LABELS: Record<StretchItem['status'], string> = {
  queued: 'Queued',
  rendering: 'Rendering',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled'
}

interface Props {
  item: StretchItem
  onCancel(id: string): void
  onRetry(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
}

function fileName(p: string | undefined): string | undefined {
  if (!p) return undefined
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1]
}

export function StretchRow({
  item,
  onCancel,
  onRetry,
  onRemove,
  onShow
}: Props): React.JSX.Element {
  const active = item.status === 'rendering'
  const known = item.durationSeconds !== undefined && item.durationSeconds > 0
  const pct = known
    ? Math.min(100, ((item.renderedSeconds ?? 0) / (item.durationSeconds as number)) * 100)
    : 0

  const barClass = [
    'bar',
    item.status === 'done' ? 'bar-done' : '',
    item.status === 'error' ? 'bar-error' : '',
    item.status === 'canceled' ? 'bar-canceled' : '',
    active && !known ? 'bar-indeterminate' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const modeLabel = FIT_MODES.find((m) => m.id === item.mode)?.label ?? item.mode
  const sizes =
    item.sourceWidth && item.outputWidth
      ? `${item.sourceWidth}×${item.sourceHeight} → ${item.outputWidth}×${item.outputHeight}`
      : undefined

  let detail: React.JSX.Element | string = ''
  if (item.status === 'rendering') {
    detail = known
      ? `${duration(item.renderedSeconds)} of ${duration(item.durationSeconds)}`
      : 'Reading the file…'
  } else if (item.status === 'done') {
    detail = fileName(item.filePath) ?? 'Saved'
  } else if (item.status === 'error') {
    detail = <span className="detail-error">{item.error ?? 'Render failed.'}</span>
  } else if (item.status === 'queued') {
    detail = 'Waiting for a free slot'
  } else if (item.status === 'canceled') {
    detail = 'Canceled — partial file removed'
  }

  // A tiny proxy of the target shape, so the chosen aspect reads at a glance.
  const ar = ASPECTS[item.aspect]
  const boxW = ar.w >= ar.h ? 42 : (42 * ar.w) / ar.h
  const boxH = ar.h >= ar.w ? 42 : (42 * ar.h) / ar.w

  return (
    <li className={`row row-${item.status}`}>
      <div className="aspect-glyph" aria-hidden="true">
        <div className="aspect-box" style={{ width: `${boxW}px`, height: `${boxH}px` }} />
      </div>

      <div className="row-body">
        <div className="row-title" title={item.inputPath}>
          {item.fileName}
        </div>

        <div className="row-meta">
          <span className="badge">{ar.label}</span>
          <span className="badge">{modeLabel}</span>
          <span className={`status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
          {sizes ? <span className="dim">{sizes}</span> : null}
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
