import { useCallback, useEffect, useState } from 'react'
import type { AspectId, FitMode, Settings, StretchItem } from '../shared/types.ts'
import {
  ASPECTS,
  ASPECT_IDS,
  FIT_MODES,
  STRETCH_DEFAULTS,
  VIDEO_EXTENSIONS
} from '../shared/types.ts'
import { OutputFolder } from './OutputFolder.tsx'
import { StretchRow } from './StretchRow.tsx'

interface Props {
  settings: Settings | null
  onSettings(next: Settings): void
  onToast(message: string): void
}

const MODE_HINTS: Record<FitMode, string> = {
  stretch: 'Squeezes the whole frame into the new shape. Nothing is cut, but people look wrong.',
  crop: 'Keeps the middle at full size and cuts the sides off. The usual choice for TV to phone.',
  pad: 'Shows the whole frame with black bars filling the rest.',
  blur: 'Whole frame centred, with a blurred blow-up of itself filling the rest.'
}

export function StretchPanel({ settings, onSettings, onToast }: Props): React.JSX.Element {
  const [aspect, setAspect] = useState<AspectId>(STRETCH_DEFAULTS.aspect)
  const [mode, setMode] = useState<FitMode>(STRETCH_DEFAULTS.mode)
  const [items, setItems] = useState<StretchItem[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void window.api.listStretch().then(setItems)

    const offUpdate = window.api.onStretchUpdate((item) => {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id)
        if (idx === -1) return [item, ...prev]
        const next = prev.slice()
        next[idx] = item
        return next
      })
    })
    const offRemoved = window.api.onStretchRemoved((id) => {
      setItems((prev) => prev.filter((i) => i.id !== id))
    })
    return () => {
      offUpdate()
      offRemoved()
    }
  }, [])

  const render = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
      try {
        await window.api.startStretch({ paths, aspect, mode })
      } catch (e) {
        onToast(e instanceof Error ? e.message : 'Could not start that render.')
      }
    },
    [aspect, mode, onToast]
  )

  const choose = useCallback(async () => {
    const paths = await window.api.pickVideoFiles()
    if (!paths.length) return
    await render(paths)
  }, [render])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)

      // Electron 33 removed File.path, so the real path comes from webUtils.
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
      void render(videos)
    },
    [render, onToast]
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
          <div className="dropzone-title">Drop video files here</div>
          <div className="dim small">or click to choose · {VIDEO_EXTENSIONS.join('  ')}</div>
        </div>

        <div className="formats">
          {ASPECT_IDS.map((id) => (
            <button
              key={id}
              className={`format ${aspect === id ? 'format-active' : ''}`}
              onClick={() => setAspect(id)}
              aria-pressed={aspect === id}
            >
              <span className="format-label">{ASPECTS[id].label}</span>
              <span className="format-sub">{ASPECTS[id].sub}</span>
            </button>
          ))}
        </div>

        <div className="formats">
          {FIT_MODES.map((m) => (
            <button
              key={m.id}
              className={`format ${mode === m.id ? 'format-active' : ''}`}
              onClick={() => setMode(m.id)}
              aria-pressed={mode === m.id}
            >
              <span className="format-label">{m.label}</span>
              <span className="format-sub">{m.sub}</span>
            </button>
          ))}
        </div>

        <p className="hint">{MODE_HINTS[mode]}</p>

        <p className="hint">
          Reframing always re-encodes — there is no copy path for scaling. The video is
          rendered at CRF 17 with Lanczos scaling, and the <strong>audio is copied
          untouched</strong> whenever MP4 can hold it.
        </p>

        <OutputFolder settings={settings} onSettings={onSettings} />
      </section>

      <ul className="rows">
        {items.length === 0 ? (
          <li className="empty">Reframed videos will show up here.</li>
        ) : (
          items.map((item) => (
            <StretchRow
              key={item.id}
              item={item}
              onCancel={(id) => void window.api.cancelStretch(id)}
              onRetry={(id) => void window.api.retryStretch(id)}
              onRemove={(id) => void window.api.removeStretch(id)}
              onShow={(id) => void window.api.showStretchInFolder(id)}
            />
          ))
        )}
      </ul>
    </>
  )
}
