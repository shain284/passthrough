import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import type {
  BinaryVersions,
  FxRequest,
  Settings,
  StretchRequest,
  StartRequest,
  UpdateResult
} from '../shared/types.ts'
import { FORMAT_IDS, FX_EXTENSIONS, VIDEO_EXTENSIONS } from '../shared/types.ts'
import { ffmpegPath, ffmpegVersion, selfUpdate, ytDlpPath, ytDlpVersion } from './binaries.ts'
import { fxQueue, isAcceptableAudioPath } from './fxqueue.ts'
import { isAcceptableVideoPath, stretchQueue } from './stretchqueue.ts'
import { openLog } from './logger.ts'
import { fetchMeta } from './metadata.ts'
import { queue } from './queue.ts'
import { getSettings, saveSettings } from './settings.ts'
import { isAllowedUrl } from './urls.ts'

function asString(value: unknown, max = 4096): string {
  if (typeof value !== 'string') throw new Error('Expected a string.')
  if (value.length > max) throw new Error('Input too long.')
  return value
}

function asId(value: unknown): string {
  const s = asString(value, 64)
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw new Error('Bad id.')
  return s
}

function asStartRequest(value: unknown): StartRequest {
  if (typeof value !== 'object' || value === null) throw new Error('Bad request.')
  const raw = value as Record<string, unknown>
  const url = asString(raw.url, 2048)
  if (!isAllowedUrl(url)) throw new Error('That link is not a supported YouTube or TikTok URL.')
  const format = raw.format
  if (typeof format !== 'string' || !FORMAT_IDS.includes(format as never)) {
    throw new Error('Unknown format.')
  }

  const meta = raw.meta
  return {
    url,
    format: format as StartRequest['format'],
    useCookies: raw.useCookies === true,
    meta:
      typeof meta === 'object' && meta !== null
        ? {
            id: String((meta as Record<string, unknown>).id ?? ''),
            title: String((meta as Record<string, unknown>).title ?? ''),
            thumbnail: (meta as Record<string, unknown>).thumbnail as string | undefined,
            duration: (meta as Record<string, unknown>).duration as number | undefined,
            uploader: (meta as Record<string, unknown>).uploader as string | undefined
          }
        : undefined
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('app:ping', () => 'pong')

  ipcMain.handle('bin:versions', async (): Promise<BinaryVersions> => {
    const [ytDlp, ffmpeg] = await Promise.all([ytDlpVersion(), ffmpegVersion()])
    const missing: string[] = []
    if (!ytDlp) missing.push('yt-dlp')
    if (!ffmpeg) missing.push('ffmpeg')
    return {
      ytDlp,
      ffmpeg,
      ytDlpPath,
      ffmpegPath,
      error: missing.length
        ? `Could not run ${missing.join(' or ')}. Check resources/bin/${process.platform}.`
        : undefined
    }
  })

  ipcMain.handle('bin:update', async (): Promise<UpdateResult> => selfUpdate())

  ipcMain.handle('settings:get', (): Settings => getSettings())

  ipcMain.handle('settings:chooseDir', async (): Promise<Settings> => {
    const win = getWindow()
    const opts = {
      title: 'Choose where downloads are saved',
      defaultPath: getSettings().outputDir,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return getSettings()
    return saveSettings({ outputDir: result.filePaths[0] })
  })

  ipcMain.handle('settings:useCookies', (_e, value: unknown): Settings => {
    const next = saveSettings({ useCookies: value === true })
    queue.setCookiePreference(next.useCookies)
    return next
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('url:validate', (_e, url: unknown) => {
    try {
      return isAllowedUrl(asString(url, 2048))
    } catch {
      return false
    }
  })

  ipcMain.handle('meta:fetch', async (_e, url: unknown) => {
    const raw = asString(url, 2048)
    if (!isAllowedUrl(raw)) throw new Error('That link is not a supported YouTube or TikTok URL.')
    return fetchMeta(raw, getSettings().useCookies)
  })

  ipcMain.handle('dl:list', () => queue.list())
  ipcMain.handle('dl:start', (_e, req: unknown) => queue.add(asStartRequest(req)))
  ipcMain.handle('dl:cancel', (_e, id: unknown) => queue.cancel(asId(id)))
  ipcMain.handle('dl:retry', (_e, id: unknown) => queue.retry(asId(id)))
  ipcMain.handle('dl:remove', (_e, id: unknown) => queue.remove(asId(id)))

  ipcMain.handle('dl:showInFolder', (_e, id: unknown) => {
    const item = queue.get(asId(id))
    if (item?.filePath && fs.existsSync(item.filePath)) {
      shell.showItemInFolder(item.filePath)
      return
    }
    // The file moved or we never captured its path — settle for the folder.
    void shell.openPath(getSettings().outputDir)
  })

  ipcMain.handle('dl:openOutputDir', () => shell.openPath(getSettings().outputDir))
  ipcMain.handle('log:open', () => openLog())

  /* -- Slowed + reverb ---------------------------------------------------- */

  ipcMain.handle('fx:pick', async (): Promise<string[]> => {
    const win = getWindow()
    const opts = {
      title: 'Choose audio files',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [
        { name: 'Audio', extensions: FX_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled) return []
    return result.filePaths.filter(isAcceptableAudioPath)
  })

  ipcMain.handle('fx:list', () => fxQueue.list())

  ipcMain.handle('fx:start', (_e, req: unknown) => {
    if (typeof req !== 'object' || req === null) throw new Error('Bad request.')
    const raw = req as Record<string, unknown>
    if (!Array.isArray(raw.paths)) throw new Error('Bad request.')
    if (raw.paths.length > 200) throw new Error('Too many files at once.')

    // Paths can arrive from drag-and-drop, so they are re-checked here rather
    // than trusted because the renderer sent them.
    const paths = raw.paths.filter(isAcceptableAudioPath)
    if (!paths.length) throw new Error('No supported audio files in that selection.')

    const fxReq: FxRequest = {
      paths,
      speed: Number(raw.speed),
      reverb: Number(raw.reverb)
    }
    return fxQueue.add(fxReq)
  })

  ipcMain.handle('fx:cancel', (_e, id: unknown) => fxQueue.cancel(asId(id)))
  ipcMain.handle('fx:retry', (_e, id: unknown) => fxQueue.retry(asId(id)))
  ipcMain.handle('fx:remove', (_e, id: unknown) => fxQueue.remove(asId(id)))

  ipcMain.handle('fx:showInFolder', (_e, id: unknown) => {
    const item = fxQueue.get(asId(id))
    if (item?.filePath && fs.existsSync(item.filePath)) {
      shell.showItemInFolder(item.filePath)
      return
    }
    void shell.openPath(getSettings().outputDir)
  })

  /* -- Aspect ratio stretcher --------------------------------------------- */

  ipcMain.handle('stretch:pick', async (): Promise<string[]> => {
    const win = getWindow()
    const opts = {
      title: 'Choose video files',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled) return []
    return result.filePaths.filter(isAcceptableVideoPath)
  })

  ipcMain.handle('stretch:list', () => stretchQueue.list())

  ipcMain.handle('stretch:start', (_e, req: unknown) => {
    if (typeof req !== 'object' || req === null) throw new Error('Bad request.')
    const raw = req as Record<string, unknown>
    if (!Array.isArray(raw.paths)) throw new Error('Bad request.')
    if (raw.paths.length > 200) throw new Error('Too many files at once.')

    // Paths can arrive from drag-and-drop, so they are re-checked here rather
    // than trusted because the renderer sent them.
    const paths = raw.paths.filter(isAcceptableVideoPath)
    if (!paths.length) throw new Error('No supported video files in that selection.')

    const stretchReq: StretchRequest = {
      paths,
      aspect: raw.aspect as StretchRequest['aspect'],
      mode: raw.mode as StretchRequest['mode']
    }
    return stretchQueue.add(stretchReq)
  })

  ipcMain.handle('stretch:cancel', (_e, id: unknown) => stretchQueue.cancel(asId(id)))
  ipcMain.handle('stretch:retry', (_e, id: unknown) => stretchQueue.retry(asId(id)))
  ipcMain.handle('stretch:remove', (_e, id: unknown) => stretchQueue.remove(asId(id)))

  ipcMain.handle('stretch:showInFolder', (_e, id: unknown) => {
    const item = stretchQueue.get(asId(id))
    if (item?.filePath && fs.existsSync(item.filePath)) {
      shell.showItemInFolder(item.filePath)
      return
    }
    void shell.openPath(getSettings().outputDir)
  })
}

/** Wires queue events to the renderer. Called once the window exists. */
export function bridgeQueueEvents(win: BrowserWindow): void {
  const onUpdate = (item: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('dl:update', item)
  }
  const onRemoved = (id: string): void => {
    if (!win.isDestroyed()) win.webContents.send('dl:removed', id)
  }
  const onFxUpdate = (item: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('fx:update', item)
  }
  const onFxRemoved = (id: string): void => {
    if (!win.isDestroyed()) win.webContents.send('fx:removed', id)
  }

  const onStretchUpdate = (item: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('stretch:update', item)
  }
  const onStretchRemoved = (id: string): void => {
    if (!win.isDestroyed()) win.webContents.send('stretch:removed', id)
  }

  queue.on('update', onUpdate)
  queue.on('removed', onRemoved)
  fxQueue.on('update', onFxUpdate)
  fxQueue.on('removed', onFxRemoved)
  stretchQueue.on('update', onStretchUpdate)
  stretchQueue.on('removed', onStretchRemoved)

  win.on('closed', () => {
    queue.off('update', onUpdate)
    queue.off('removed', onRemoved)
    fxQueue.off('update', onFxUpdate)
    fxQueue.off('removed', onFxRemoved)
    stretchQueue.off('update', onStretchUpdate)
    stretchQueue.off('removed', onStretchRemoved)
  })
}
