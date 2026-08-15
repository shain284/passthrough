import { useCallback, useEffect, useState } from 'react'
import type { Settings, UpscaleFactor, UpscaleItem } from '../shared/types.ts'
import {
  UPSCALE_DEFAULTS,
  UPSCALE_FACTORS,
  UPSCALE_LONG_CLIP_SECONDS,
  VIDEO_EXTENSIONS
} from '../shared/types.ts'
import { OutputFolder } from './OutputFolder.tsx'
import { UpscaleRow, longDuration } from './UpscaleRow.tsx'

interface Props {
  settings: Settings | null
  onSettings(next: Settings): void
  onToast(message: string): void
}

const FACTOR_SUB: Record<UpscaleFactor, string> = {
  2: '480p → 960p',
  3: '480p → 1440p',
  4: '480p → 1920p'
}

export function UpscalePanel({ settings, onSettings, onToast }: Props): React.JSX.Element {
  const [factor, setFactor] = useState<UpscaleFactor>(UPSCALE_DEFAULTS.factor)
  const [items, setItems] = useState<UpscaleItem[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void window.api.listUpscale().then(setItems)

    const offUpdate = window.api.onUpscaleUpdate((item) => {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id)
        if (idx === -1) return [item, ...prev]
        const next = prev.slice()
        next[idx] = item
        return next
      })
    })
    const offRemoved = window.api.onUpscaleRemoved((id) => {
      setItems((prev) => prev.filter((i) => i.id !== id))
    })
    return () => {
      offUpdate()
      offRemoved()
    }
  }, [])

  const start = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
      try {
        await window.api.startUpscale({ paths, factor })
      } catch (e) {
        onToast(e instanceof Error ? e.message : 'Could not start that upscale.')
      }
    },
    [factor, onToast]
  )

  const choose = useCallback(async () => {
    const paths = await window.api.pickVideoFilesForUpscale()
    if (!paths.length) return
    await start(paths)
  }, [start])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)

      const paths = Array.from(event.dataTransfer.files)
        .map((file) => {
          try {
            return window.api.getPathForFile(file)
          } catch {
            return ''
          }
        })
        .filter(Boolean)

      const videos = paths.filter((p) =>
        VIDEO_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))
      )
      if (!videos.length) {
        onToast(`Drop video files — ${VIDEO_EXTENSIONS.join(', ')}.`)
        return
      }
      void start(videos)
    },
    [start, onToast]
  )

  // Anything long enough to be an episode rather than a clip deserves a warning
  // before it eats the afternoon.
  const longOne = items.find(
    (i) =>
      (i.status === 'queued' || i.status === 'rendering') &&
      (i.durationSeconds ?? 0) > UPSCALE_LONG_CLIP_SECONDS
  )

  return (
    <>
      <section className="panel">
        <div
          className={`dropzone ${dragging ? 'dropzone-active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => void choose()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') void choose()
          }}
        >
          <div className="dropzone-title">Drop clips here</div>
          <div className="dim small">or click to choose · {VIDEO_EXTENSIONS.join('  ')}</div>
        </div>

        <div className="formats">
          {UPSCALE_FACTORS.map((f) => (
            <button
              key={f}
              className={`format ${factor === f ? 'format-active' : ''}`}
              onClick={() => setFactor(f)}
              aria-pressed={factor === f}
            >
              <span className="format-label">{f}×</span>
              <span className="format-sub">{FACTOR_SUB[f]}</span>
            </button>
          ))}
        </div>

        <p className="hint">
          Real-ESRGAN&apos;s anime model reconstructs line art and flat colour rather than just
          enlarging pixels, so it suits older cel animation. It runs on the GPU and is slow:
          roughly <strong>4 minutes per 30 seconds</strong> of 480p at 2×. Built for clips —
          a whole episode takes hours.
        </p>

        {longOne ? (
          <div className="banner banner-warn">
            {longOne.fileName} is {longDuration(longOne.durationSeconds)} long
            {longOne.etaSeconds !== undefined
              ? ` — expect around ${longDuration(longOne.etaSeconds)} of processing`
              : ''}
            . Cancelling is safe at any point; scratch files are cleaned up.
          </div>
        ) : null}

        <OutputFolder settings={settings} onSettings={onSettings} />
      </section>

      <ul className="rows">
        {items.length === 0 ? (
          <li className="empty">Upscaled clips will show up here.</li>
        ) : (
          items.map((item) => (
            <UpscaleRow
              key={item.id}
              item={item}
              onCancel={(id) => void window.api.cancelUpscale(id)}
              onRetry={(id) => void window.api.retryUpscale(id)}
              onRemove={(id) => void window.api.removeUpscale(id)}
              onShow={(id) => void window.api.showUpscaleInFolder(id)}
            />
          ))
        )}
      </ul>
    </>
  )
}
