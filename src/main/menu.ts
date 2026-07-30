import { BrowserWindow, Menu, app, dialog, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { ffmpegVersion, selfUpdate, ytDlpVersion } from './binaries'
import { openLog } from './logger'
import { getSettings } from './settings'

async function runUpdate(win: BrowserWindow | null): Promise<void> {
  const result = await selfUpdate()
  const version = await ytDlpVersion()
  const message = result.ok ? 'yt-dlp update check finished' : 'Could not update yt-dlp'
  const detail = `${result.output.trim() || '(no output)'}\n\nInstalled version: ${version ?? 'unknown'}`
  const opts = { type: result.ok ? ('info' as const) : ('error' as const), message, detail }
  if (win) await dialog.showMessageBox(win, opts)
  else await dialog.showMessageBox(opts)
}

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Download Folder',
          click: () => void shell.openPath(getSettings().outputDir)
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates (yt-dlp)',
          click: () => void runUpdate(getWindow())
        },
        {
          label: 'Open Log File',
          click: () => void openLog()
        },
        { type: 'separator' },
        {
          label: `About ${app.getName()}`,
          click: async () => {
            const [ytDlp, ffmpeg] = await Promise.all([ytDlpVersion(), ffmpegVersion()])
            const win = getWindow()
            const opts = {
              type: 'info' as const,
              message: `${app.getName()} ${app.getVersion()}`,
              detail: [
                `Electron ${process.versions.electron}`,
                `yt-dlp ${ytDlp ?? 'not found'}`,
                `ffmpeg ${ffmpeg ?? 'not found'}`,
                '',
                'Video streams are never re-encoded.'
              ].join('\n')
            }
            if (win) await dialog.showMessageBox(win, opts)
            else await dialog.showMessageBox(opts)
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
