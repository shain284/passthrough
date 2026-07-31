import { useCallback, useEffect, useState } from 'react'
import type { BinaryVersions, Settings } from '../shared/types.ts'
import { DownloadPanel } from './DownloadPanel.tsx'
import { FxPanel } from './FxPanel.tsx'

type Tab = 'download' | 'fx'

const TABS: { id: Tab; label: string; tagline: string }[] = [
  { id: 'download', label: 'Download', tagline: 'no re-encoding, ever' },
  { id: 'fx', label: 'Slowed + Reverb', tagline: 'renders a new file' }
]

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('download')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [versions, setVersions] = useState<BinaryVersions | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.getVersions().then(setVersions)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  // A file dropped outside the drop zone would otherwise navigate the window
  // away from the app.
  useEffect(() => {
    const swallow = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const checkUpdates = useCallback(async () => {
    setUpdating(true)
    try {
      const result = await window.api.updateYtDlp()
      setToast(result.output.split('\n').filter(Boolean).slice(-2).join(' · ') || 'Update finished.')
      setVersions(await window.api.getVersions())
    } finally {
      setUpdating(false)
    }
  }, [])

  const binariesMissing = versions !== null && (!versions.ytDlp || !versions.ffmpeg)
  const tagline = TABS.find((t) => t.id === tab)?.tagline ?? ''

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-name">Passthrough</span>
          <span className="brand-sub">{tagline}</span>
        </div>
        <div className="header-right">
          <span className="dim small">
            yt-dlp {versions?.ytDlp ?? '—'} · ffmpeg {versions?.ffmpeg ?? '—'}
          </span>
          <button className="btn btn-quiet" onClick={checkUpdates} disabled={updating}>
            {updating ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {binariesMissing ? (
        <div className="banner banner-error">
          {versions?.error ?? 'Bundled binaries are missing.'}{' '}
          <button className="link" onClick={() => void window.api.openLog()}>
            Open log
          </button>
        </div>
      ) : null}

      {toast ? <div className="banner">{toast}</div> : null}

      {tab === 'download' ? (
        <DownloadPanel
          settings={settings}
          onSettings={setSettings}
          onToast={setToast}
          onCheckUpdates={() => void checkUpdates()}
        />
      ) : (
        <FxPanel settings={settings} onSettings={setSettings} onToast={setToast} />
      )}
    </div>
  )
}
