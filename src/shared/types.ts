/** Types shared across main, preload and renderer. Type-only — nothing here emits code. */

export type FormatId = 'mp4' | 'audio-original' | 'mp3-320' | 'mp3-v0'

export const FORMAT_IDS: FormatId[] = ['mp4', 'audio-original', 'mp3-320', 'mp3-v0']

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'done'
  | 'error'
  | 'canceled'

/** What the UI should offer the user when a download fails. */
export type ErrorAction = 'retry' | 'use-cookies' | 'update-ytdlp' | 'none'

export interface DownloadError {
  /** Plain-English, one sentence, shown in the row. */
  message: string
  action: ErrorAction
}

export interface VideoMeta {
  id: string
  title: string
  thumbnail?: string
  duration?: number
  uploader?: string
  extractor?: string
}

export interface DownloadItem {
  id: string
  url: string
  format: FormatId
  status: DownloadStatus
  useCookies: boolean

  /** yt-dlp's own id for the video, used to target this row's .part files. */
  videoId?: string
  title: string
  thumbnail?: string
  duration?: number
  uploader?: string

  downloadedBytes?: number
  /** null when yt-dlp reports NA for both total_bytes and total_bytes_estimate. */
  totalBytes?: number
  /** True when totalBytes came from total_bytes_estimate rather than total_bytes. */
  totalIsEstimate?: boolean
  speed?: number
  eta?: number

  filePath?: string
  error?: DownloadError
  /** Set when we had to keep an mkv because the stream refused to remux to mp4. */
  note?: string

  createdAt: number
}

export interface Settings {
  outputDir: string
  useCookies: boolean
}

/* -- Slowed + reverb ------------------------------------------------------ */

export type FxStatus = 'queued' | 'rendering' | 'done' | 'error' | 'canceled'

export const SPEED_MIN = 0.5
export const SPEED_MAX = 1
export const REVERB_MIN = 0
export const REVERB_MAX = 1

export const FX_DEFAULTS = { speed: 0.85, reverb: 0.35 }

/** Extensions the render tab will accept. */
export const FX_EXTENSIONS = ['.mp3', '.m4a', '.opus', '.wav', '.flac', '.aac', '.ogg', '.wma']

export interface FxItem {
  id: string
  inputPath: string
  fileName: string
  status: FxStatus

  /** Playback rate. 0.85 means 85% speed, which drops pitch to match. */
  speed: number
  /** Wet mix, 0 = untouched, 1 = reverb as loud as the source. */
  reverb: number

  /** Source length in seconds, from ffprobe. */
  durationIn?: number
  /** durationIn / speed, plus the reverb tail. What the bar measures against. */
  durationOut?: number
  /** How far ffmpeg has written, in output seconds. */
  renderedSeconds?: number

  filePath?: string
  error?: string
  createdAt: number
}

export interface FxRequest {
  paths: string[]
  speed: number
  reverb: number
}

/* -- Aspect ratio stretcher ----------------------------------------------- */

export type AspectId = '9:16' | '1:1' | '4:5' | '16:9'

export const ASPECTS: Record<AspectId, { w: number; h: number; label: string; sub: string }> = {
  '9:16': { w: 9, h: 16, label: '9:16', sub: 'phone, Reels, Shorts' },
  '1:1': { w: 1, h: 1, label: '1:1', sub: 'square feed' },
  '4:5': { w: 4, h: 5, label: '4:5', sub: 'portrait feed' },
  '16:9': { w: 16, h: 9, label: '16:9', sub: 'TV, desktop' }
}

export const ASPECT_IDS: AspectId[] = ['9:16', '1:1', '4:5', '16:9']

/** How the source frame is made to fit the new aspect ratio. */
export type FitMode = 'stretch' | 'crop' | 'pad' | 'blur'

export const FIT_MODES: { id: FitMode; label: string; sub: string }[] = [
  { id: 'stretch', label: 'Stretch', sub: 'fills, distorts' },
  { id: 'crop', label: 'Fill', sub: 'crops the sides' },
  { id: 'pad', label: 'Fit', sub: 'black bars' },
  { id: 'blur', label: 'Blur', sub: 'blurred backdrop' }
]

export const FIT_MODE_IDS: FitMode[] = ['stretch', 'crop', 'pad', 'blur']

export const STRETCH_DEFAULTS = { aspect: '9:16' as AspectId, mode: 'stretch' as FitMode }

/** Containers the stretch tab will accept. Output is always MP4. */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']

export type StretchStatus = 'queued' | 'rendering' | 'done' | 'error' | 'canceled'

export interface StretchItem {
  id: string
  inputPath: string
  fileName: string
  status: StretchStatus

  aspect: AspectId
  mode: FitMode

  /** Source dimensions, from ffprobe. */
  sourceWidth?: number
  sourceHeight?: number
  /** Computed output dimensions. */
  outputWidth?: number
  outputHeight?: number
  /** True when the audio was stream-copied rather than re-encoded. */
  audioCopied?: boolean

  durationSeconds?: number
  renderedSeconds?: number

  filePath?: string
  error?: string
  createdAt: number
}

export interface StretchRequest {
  paths: string[]
  aspect: AspectId
  mode: FitMode
}

export interface BinaryVersions {
  ytDlp: string | null
  ffmpeg: string | null
  ytDlpPath: string
  ffmpegPath: string
  error?: string
}

export interface StartRequest {
  url: string
  format: FormatId
  useCookies: boolean
  meta?: VideoMeta
}

export interface UpdateResult {
  ok: boolean
  output: string
}

/** The surface exposed on window.api by the preload contextBridge. */
export interface RendererApi {
  ping(): Promise<string>
  getVersions(): Promise<BinaryVersions>
  updateYtDlp(): Promise<UpdateResult>

  getSettings(): Promise<Settings>
  chooseOutputDir(): Promise<Settings>
  setUseCookies(value: boolean): Promise<Settings>

  readClipboard(): Promise<string>
  validateUrl(url: string): Promise<boolean>
  fetchMeta(url: string): Promise<VideoMeta>

  listDownloads(): Promise<DownloadItem[]>
  startDownload(req: StartRequest): Promise<DownloadItem>
  cancelDownload(id: string): Promise<void>
  retryDownload(id: string): Promise<void>
  removeDownload(id: string): Promise<void>

  showInFolder(id: string): Promise<void>
  openOutputDir(): Promise<void>
  openLog(): Promise<void>

  onDownloadUpdate(cb: (item: DownloadItem) => void): () => void
  onDownloadRemoved(cb: (id: string) => void): () => void
  onOpenAbout(cb: () => void): () => void

  /* Slowed + reverb */
  pickAudioFiles(): Promise<string[]>
  listFx(): Promise<FxItem[]>
  startFx(req: FxRequest): Promise<FxItem[]>
  cancelFx(id: string): Promise<void>
  retryFx(id: string): Promise<void>
  removeFx(id: string): Promise<void>
  showFxInFolder(id: string): Promise<void>
  onFxUpdate(cb: (item: FxItem) => void): () => void
  onFxRemoved(cb: (id: string) => void): () => void

  /* Aspect ratio stretcher */
  pickVideoFiles(): Promise<string[]>
  listStretch(): Promise<StretchItem[]>
  startStretch(req: StretchRequest): Promise<StretchItem[]>
  cancelStretch(id: string): Promise<void>
  retryStretch(id: string): Promise<void>
  removeStretch(id: string): Promise<void>
  showStretchInFolder(id: string): Promise<void>
  onStretchUpdate(cb: (item: StretchItem) => void): () => void
  onStretchRemoved(cb: (id: string) => void): () => void

  /** Electron 33 removed File.path; drag-and-drop needs webUtils instead. */
  getPathForFile(file: File): string
}
