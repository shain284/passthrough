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
}
