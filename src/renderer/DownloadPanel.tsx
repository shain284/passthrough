import { useCallback, useEffect, useRef, useState } from 'react'
import type { DownloadItem, FormatId, Settings, VideoMeta } from '../shared/types.ts'
import { DownloadRow } from './DownloadRow.tsx'
import { OutputFolder } from './OutputFolder.tsx'
import { duration } from './format.ts'

const FORMATS: { id: FormatId; label: string; sub: string }[] = [
  { id: 'mp4', label: 'MP4', sub: 'best video + audio' },
  { id: 'audio-original', label: 'Audio', sub: 'original, zero loss' },
  { id: 'mp3-320', label: 'MP3 320', sub: 'constant bitrate' },
  { id: 'mp3-v0', label: 'MP3 V0', sub: 'variable bitrate' }
]

interface Props {
  settings: Settings | null
  onSettings(next: Settings): void
  onToast(message: string): void
  onCheckUpdates(): void
}

export function DownloadPanel({
  settings,
  onSettings,
  onToast,
  onCheckUpdates
}: Props): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [urlValid, setUrlValid] = useState(false)
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [format, setFormat] = useState<FormatId>('mp4')
  const [items, setItems] = useState<DownloadItem[]>([])

  const inputRef = useRef<HTMLInputElement>(null)
  const metaSeq = useRef(0)

  useEffect(() => {
    void window.api.listDownloads().then(setItems)

    const offUpdate = window.api.onDownloadUpdate((item) => {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id)
        if (idx === -1) return [item, ...prev]
        const next = prev.slice()
        next[idx] = item
        return next
      })
    })
    const offRemoved = window.api.onDownloadRemoved((id) => {
      setItems((prev) => prev.filter((i) => i.id !== id))
    })
    return () => {
      offUpdate()
      offRemoved()
    }
  }, [])

  // Validate, then pull title and thumbnail so the row is populated before the
  // first byte moves.
  useEffect(() => {
    let cancelled = false
    const trimmed = url.trim()
    if (!trimmed) {
      setUrlValid(false)
      setMeta(null)
      setMetaError(null)
      setMetaLoading(false)
      return
    }

    const timer = setTimeout(async () => {
      const valid = await window.api.validateUrl(trimmed)
      if (cancelled) return
      setUrlValid(valid)
      if (!valid) {
        setMeta(null)
        setMetaError(null)
        setMetaLoading(false)
        return
      }

      const seq = ++metaSeq.current
      setMetaLoading(true)
      setMetaError(null)
      try {
        const result = await window.api.fetchMeta(trimmed)
        if (cancelled || seq !== metaSeq.current) return
        setMeta(result)
      } catch (e) {
        if (cancelled || seq !== metaSeq.current) return
        setMeta(null)
        setMetaError(e instanceof Error ? e.message : 'Could not read that link.')
      } finally {
        if (!cancelled && seq === metaSeq.current) setMetaLoading(false)
      }
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [url])

  const handleFocus = useCallback(async () => {
    if (url.trim()) return
    const text = (await window.api.readClipboard()).trim()
    if (!text || text.length > 2048) return
    if (await window.api.validateUrl(text)) setUrl(text)
  }, [url])

  const start = useCallback(async () => {
    const trimmed = url.trim()
    if (!trimmed || !urlValid) return
    try {
      await window.api.startDownload({
        url: trimmed,
        format,
        useCookies: settings?.useCookies === true,
        meta: meta ?? undefined
      })
      setUrl('')
      setMeta(null)
      setUrlValid(false)
      inputRef.current?.focus()
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not start that download.')
    }
  }, [url, urlValid, format, settings, meta, onToast])

  const enableCookies = useCallback(async () => {
    onSettings(await window.api.setUseCookies(true))
    onToast('Browser cookies turned on. Retry the download.')
  }, [onSettings, onToast])

  return (
    <>
      <section className="panel">
        <div className={`url-field ${url && !urlValid ? 'invalid' : ''}`}>
          <input
            ref={inputRef}
            type="text"
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste a YouTube or TikTok link"
            onFocus={handleFocus}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void start()
            }}
          />
          {url ? (
            <button className="btn btn-icon" aria-label="Clear" onClick={() => setUrl('')}>
              ×
            </button>
          ) : null}
        </div>

        {url && !urlValid ? (
          <p className="hint hint-error">Only YouTube and TikTok links are accepted.</p>
        ) : null}

        {urlValid && (metaLoading || meta || metaError) ? (
          <div className="preview">
            {meta?.thumbnail ? (
              <img src={meta.thumbnail} alt="" referrerPolicy="no-referrer" />
            ) : (
              <div className="preview-placeholder" />
            )}
            <div className="preview-text">
              {metaLoading ? (
                <span className="dim">Reading video info…</span>
              ) : metaError ? (
                <span className="detail-error">{metaError}</span>
              ) : (
                <>
                  <div className="preview-title">{meta?.title}</div>
                  <div className="dim small">
                    {[meta?.uploader, duration(meta?.duration)].filter(Boolean).join(' · ')}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}

        <div className="formats">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`format ${format === f.id ? 'format-active' : ''}`}
              onClick={() => setFormat(f.id)}
              aria-pressed={format === f.id}
            >
              <span className="format-label">{f.label}</span>
              <span className="format-sub">{f.sub}</span>
            </button>
          ))}
        </div>

        <p className="hint">
          Source audio is already lossy Opus or AAC, so MP3 re-encodes it and loses a little. Use{' '}
          <strong>Audio</strong> for a true copy.
        </p>

        <div className="actions">
          <button className="btn btn-primary" disabled={!urlValid} onClick={() => void start()}>
            Download
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={settings?.useCookies === true}
              onChange={async (e) => onSettings(await window.api.setUseCookies(e.target.checked))}
            />
            Use browser cookies (Chrome)
          </label>
        </div>

        <OutputFolder settings={settings} onSettings={onSettings} />
      </section>

      <ul className="rows">
        {items.length === 0 ? (
          <li className="empty">Downloads will show up here.</li>
        ) : (
          items.map((item) => (
            <DownloadRow
              key={item.id}
              item={item}
              onCancel={(id) => void window.api.cancelDownload(id)}
              onRetry={(id) => void window.api.retryDownload(id)}
              onRemove={(id) => void window.api.removeDownload(id)}
              onShow={(id) => void window.api.showInFolder(id)}
              onUseCookies={() => void enableCookies()}
              onCheckUpdates={onCheckUpdates}
            />
          ))
        )}
      </ul>
    </>
  )
}
