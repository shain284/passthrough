import type { FxItem } from '../shared/types.ts'
import { duration } from './format.ts'

const STATUS_LABELS: Record<FxItem['status'], string> = {
  queued: 'Queued',
  rendering: 'Rendering',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled'
}

interface Props {
  item: FxItem
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

/** 0.85x is about 2.8 semitones down, which is the part people actually hear. */
export function semitones(speed: number): string {
  const st = 12 * Math.log2(speed)
  if (Math.abs(st) < 0.05) return '0 st'
  return `${st > 0 ? '+' : '−'}${Math.abs(st).toFixed(1)} st`
}

export function FxRow({ item, onCancel, onRetry, onRemove, onShow }: Props): React.JSX.Element {
  const active = item.status === 'rendering'
  const known = item.durationOut !== undefined && item.durationOut > 0
  const pct = known
    ? Math.min(100, ((item.renderedSeconds ?? 0) / (item.durationOut as number)) * 100)
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

  let detail: React.JSX.Element | string = ''
  if (item.status === 'rendering') {
    detail = known
      ? `${duration(item.renderedSeconds)} of ${duration(item.durationOut)}`
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

  return (
    <li className={`row row-${item.status}`}>
      <div className="fx-glyph" aria-hidden="true">
        ♪
      </div>

      <div className="row-body">
        <div className="row-title" title={item.inputPath}>
          {item.fileName}
        </div>

        <div className="row-meta">
          <span className="badge">
            {Math.round(item.speed * 100)}% · {semitones(item.speed)}
          </span>
          <span className="badge">reverb {Math.round(item.reverb * 100)}%</span>
          <span className={`status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
          {item.durationIn ? <span className="dim">{duration(item.durationIn)}</span> : null}
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
