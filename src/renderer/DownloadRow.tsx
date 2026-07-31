import type { DownloadItem, FormatId } from '../shared/types.ts'
import { bytes, duration, eta, speed } from './format.ts'

const FORMAT_LABELS: Record<FormatId, string> = {
  mp4: 'MP4',
  'audio-original': 'Audio (original)',
  'mp3-320': 'MP3 320',
  'mp3-v0': 'MP3 V0'
}

const STATUS_LABELS: Record<DownloadItem['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  processing: 'Merging',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled'
}

interface Props {
  item: DownloadItem
  onCancel(id: string): void
  onRetry(id: string): void
  onRemove(id: string): void
  onShow(id: string): void
  onUseCookies(): void
  onCheckUpdates(): void
}

function fileName(p: string | undefined): string | undefined {
  if (!p) return undefined
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1]
}

export function DownloadRow({
  item,
  onCancel,
  onRetry,
  onRemove,
  onShow,
  onUseCookies,
  onCheckUpdates
}: Props): React.JSX.Element {
  const active = item.status === 'downloading' || item.status === 'processing'
  const known = item.totalBytes !== undefined && item.totalBytes > 0
  const pct = known
    ? Math.min(100, ((item.downloadedBytes ?? 0) / (item.totalBytes as number)) * 100)
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
  if (item.status === 'downloading') {
    const size = known
      ? `${bytes(item.downloadedBytes)} of ${bytes(item.totalBytes)}${item.totalIsEstimate ? ' (est.)' : ''}`
      : bytes(item.downloadedBytes)
    detail = [size, speed(item.speed), eta(item.eta)].filter(Boolean).join(' · ')
  } else if (item.status === 'processing') {
    detail = 'Merging streams — copying, not re-encoding'
  } else if (item.status === 'done') {
    detail = fileName(item.filePath) ?? 'Saved'
  } else if (item.status === 'error' && item.error) {
    detail = <span className="detail-error">{item.error.message}</span>
  } else if (item.status === 'queued') {
    detail = 'Waiting for a free slot'
  } else if (item.status === 'canceled') {
    detail = 'Canceled — partial files removed'
  }

  return (
    <li className={`row row-${item.status}`}>
      <div className="thumb">
        {item.thumbnail ? (
          <img src={item.thumbnail} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="thumb-placeholder" />
        )}
        {item.duration ? <span className="thumb-duration">{duration(item.duration)}</span> : null}
      </div>

      <div className="row-body">
        <div className="row-title" title={item.title}>
          {item.title}
        </div>

        <div className="row-meta">
          <span className="badge">{FORMAT_LABELS[item.format]}</span>
          <span className={`status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
          {item.uploader ? <span className="dim">{item.uploader}</span> : null}
        </div>

        <div className="track">
          <div
            className={barClass}
            style={known || !active ? { width: `${item.status === 'done' ? 100 : pct}%` } : undefined}
          />
        </div>

        <div className="row-detail">{detail}</div>

        {item.note ? <div className="row-note">{item.note}</div> : null}
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

        {item.status === 'error' && item.error?.action === 'use-cookies' ? (
          <button className="btn btn-quiet" onClick={onUseCookies}>
            Use cookies &amp; retry
          </button>
        ) : null}

        {item.status === 'error' && item.error?.action === 'update-ytdlp' ? (
          <button className="btn btn-quiet" onClick={onCheckUpdates}>
            Update yt-dlp
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
