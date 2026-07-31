import { useCallback, useEffect, useState } from 'react'
import type { FxItem, Settings } from '../shared/types.ts'
import { FX_DEFAULTS, FX_EXTENSIONS, SPEED_MAX, SPEED_MIN } from '../shared/types.ts'
import { FxRow, semitones } from './FxRow.tsx'
import { OutputFolder } from './OutputFolder.tsx'

interface Props {
  settings: Settings | null
  onSettings(next: Settings): void
  onToast(message: string): void
}

export function FxPanel({ settings, onSettings, onToast }: Props): React.JSX.Element {
  const [speed, setSpeed] = useState(FX_DEFAULTS.speed)
  const [reverb, setReverb] = useState(FX_DEFAULTS.reverb)
  const [items, setItems] = useState<FxItem[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void window.api.listFx().then(setItems)

    const offUpdate = window.api.onFxUpdate((item) => {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id)
        if (idx === -1) return [item, ...prev]
        const next = prev.slice()
        next[idx] = item
        return next
      })
    })
    const offRemoved = window.api.onFxRemoved((id) => {
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
        await window.api.startFx({ paths, speed, reverb })
      } catch (e) {
        onToast(e instanceof Error ? e.message : 'Could not start that render.')
      }
    },
    [speed, reverb, onToast]
  )

  const choose = useCallback(async () => {
    const paths = await window.api.pickAudioFiles()
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

      const audio = paths.filter((p) =>
        FX_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))
      )
      if (!audio.length) {
        onToast(`Drop audio files — ${FX_EXTENSIONS.join(', ')}.`)
        return
      }
      void render(audio)
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
          <div className="dropzone-title">Drop audio files here</div>
          <div className="dim small">
            or click to choose · {FX_EXTENSIONS.join('  ')}
          </div>
        </div>

        <div className="sliders">
          <label className="slider">
            <div className="slider-head">
              <span>Speed</span>
              <span className="dim">
                {Math.round(speed * 100)}% · {semitones(speed)}
              </span>
            </div>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={0.01}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>

          <label className="slider">
            <div className="slider-head">
              <span>Reverb</span>
              <span className="dim">{Math.round(reverb * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={reverb}
              onChange={(e) => setReverb(Number(e.target.value))}
            />
          </label>
        </div>

        <p className="hint">
          Slowing drops pitch along with tempo, the way a record does. This tab renders a new
          MP3 at 320 kbps — unlike the download tab, there is no way to do it without
          re-encoding.
        </p>

        <OutputFolder settings={settings} onSettings={onSettings} />
      </section>

      <ul className="rows">
        {items.length === 0 ? (
          <li className="empty">Rendered tracks will show up here.</li>
        ) : (
          items.map((item) => (
            <FxRow
              key={item.id}
              item={item}
              onCancel={(id) => void window.api.cancelFx(id)}
              onRetry={(id) => void window.api.retryFx(id)}
              onRemove={(id) => void window.api.removeFx(id)}
              onShow={(id) => void window.api.showFxInFolder(id)}
            />
          ))
        )}
      </ul>
    </>
  )
}
