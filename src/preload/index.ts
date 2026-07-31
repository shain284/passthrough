import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  BinaryVersions,
  DownloadItem,
  FxItem,
  FxRequest,
  RendererApi,
  Settings,
  StartRequest,
  UpdateResult,
  VideoMeta
} from '../shared/types.ts'

/**
 * The entire main-process surface the renderer can see. No Node, no ipcRenderer,
 * no channel names — just these functions.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RendererApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  getVersions: () => ipcRenderer.invoke('bin:versions') as Promise<BinaryVersions>,
  updateYtDlp: () => ipcRenderer.invoke('bin:update') as Promise<UpdateResult>,

  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  chooseOutputDir: () => ipcRenderer.invoke('settings:chooseDir') as Promise<Settings>,
  setUseCookies: (value: boolean) =>
    ipcRenderer.invoke('settings:useCookies', value) as Promise<Settings>,

  readClipboard: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
  validateUrl: (url: string) => ipcRenderer.invoke('url:validate', url) as Promise<boolean>,
  fetchMeta: (url: string) => ipcRenderer.invoke('meta:fetch', url) as Promise<VideoMeta>,

  listDownloads: () => ipcRenderer.invoke('dl:list') as Promise<DownloadItem[]>,
  startDownload: (req: StartRequest) =>
    ipcRenderer.invoke('dl:start', req) as Promise<DownloadItem>,
  cancelDownload: (id: string) => ipcRenderer.invoke('dl:cancel', id) as Promise<void>,
  retryDownload: (id: string) => ipcRenderer.invoke('dl:retry', id) as Promise<void>,
  removeDownload: (id: string) => ipcRenderer.invoke('dl:remove', id) as Promise<void>,

  showInFolder: (id: string) => ipcRenderer.invoke('dl:showInFolder', id) as Promise<void>,
  openOutputDir: () => ipcRenderer.invoke('dl:openOutputDir') as Promise<void>,
  openLog: () => ipcRenderer.invoke('log:open') as Promise<void>,

  onDownloadUpdate: (cb) => subscribe<DownloadItem>('dl:update', cb),
  onDownloadRemoved: (cb) => subscribe<string>('dl:removed', cb),
  onOpenAbout: (cb) => subscribe<void>('app:about', () => cb()),

  pickAudioFiles: () => ipcRenderer.invoke('fx:pick') as Promise<string[]>,
  listFx: () => ipcRenderer.invoke('fx:list') as Promise<FxItem[]>,
  startFx: (req: FxRequest) => ipcRenderer.invoke('fx:start', req) as Promise<FxItem[]>,
  cancelFx: (id: string) => ipcRenderer.invoke('fx:cancel', id) as Promise<void>,
  retryFx: (id: string) => ipcRenderer.invoke('fx:retry', id) as Promise<void>,
  removeFx: (id: string) => ipcRenderer.invoke('fx:remove', id) as Promise<void>,
  showFxInFolder: (id: string) => ipcRenderer.invoke('fx:showInFolder', id) as Promise<void>,
  onFxUpdate: (cb) => subscribe<FxItem>('fx:update', cb),
  onFxRemoved: (cb) => subscribe<string>('fx:removed', cb),

  // Electron 33 dropped File.path; this is the supported replacement and is the
  // only way a dropped file's real path reaches the main process.
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
