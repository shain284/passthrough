import { BrowserWindow, app, shell } from 'electron'
import path from 'node:path'
import { ensureExecutable } from './binaries.ts'
import { fxQueue } from './fxqueue.ts'
import { bridgeQueueEvents, registerIpc } from './ipc.ts'
import { log } from './logger.ts'
import { buildMenu } from './menu.ts'
import { queue } from './queue.ts'

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => mainWindow

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0e0f12',
    autoHideMenuBar: false,
    title: 'Passthrough',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Nothing in this app should ever open a second Electron window or navigate
  // the renderer away from its own bundle.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  bridgeQueueEvents(mainWindow)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    ensureExecutable()
    registerIpc(getWindow)
    buildMenu(getWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

let shuttingDown = false

app.on('before-quit', (event) => {
  if (shuttingDown || (!queue.hasActive() && !fxQueue.hasActive())) return
  // Give the children a chance to die and their part files a chance to go with them.
  event.preventDefault()
  shuttingDown = true
  log('app', 'shutting down with work in flight')
  void Promise.all([queue.shutdown(), fxQueue.shutdown()]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
