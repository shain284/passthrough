import type { Settings } from '../shared/types.ts'

interface Props {
  settings: Settings | null
  onSettings(next: Settings): void
}

/** Both tabs write to the same folder the user picked once. */
export function OutputFolder({ settings, onSettings }: Props): React.JSX.Element {
  return (
    <div className="folder">
      <span className="dim small">Saving to</span>
      <button
        className="folder-path"
        title={settings?.outputDir}
        onClick={() => void window.api.openOutputDir()}
      >
        {settings?.outputDir ?? '…'}
      </button>
      <button
        className="btn btn-quiet"
        onClick={async () => onSettings(await window.api.chooseOutputDir())}
      >
        Change
      </button>
    </div>
  )
}
