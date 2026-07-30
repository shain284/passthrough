import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import type { BinaryVersions, Settings, StartRequest, UpdateResult } from '@shared/types'
import { FORMAT_IDS } from '@shared/types'
import { ffmpegPath, ffmpegVersion, selfUpdate, ytDlpPath, ytDlpVersion } from './binaries'
import { openLog } from './logger'
import { fetchMeta } from './metadata'
import { queue } from './queue'
import { getSettings, saveSettings } from './settings'
import { isAllowedUrl } from './urls'

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
}

/** Wires queue events to the renderer. Called once the window exists. */
export function bridgeQueueEvents(win: BrowserWindow): void {
  const onUpdate = (item: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('dl:update', item)
  }
  const onRemoved = (id: string): void => {
    if (!win.isDestroyed()) win.webContents.send('dl:removed', id)
  }
  queue.on('update', onUpdate)
  queue.on('removed', onRemoved)
  win.on('closed', () => {
    queue.off('update', onUpdate)
    queue.off('removed', onRemoved)
  })
}
