import { app, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Raw yt-dlp/ffmpeg output goes here and nowhere near the UI. Openable from the
 * Help menu so a user can paste it into a bug report.
 */
const MAX_BYTES = 2 * 1024 * 1024

let stream: fs.WriteStream | null = null

export function logPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'yt-dlp.log')
}

function open(): fs.WriteStream | null {
  if (stream) return stream
  try {
    const p = logPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Cheap rotation: one generation is enough to debug the last session.
    try {
      if (fs.statSync(p).size > MAX_BYTES) fs.renameSync(p, `${p}.1`)
    } catch {
      /* no existing log */
    }
    stream = fs.createWriteStream(p, { flags: 'a' })
  } catch {
    stream = null
  }
  return stream
}

export function log(scope: string, message: string): void {
  const s = open()
  if (!s) return
  const stamp = new Date().toISOString()
  for (const line of message.split(/\r?\n/)) {
    if (line.trim()) s.write(`${stamp} [${scope}] ${line}\n`)
  }
}

export async function openLog(): Promise<void> {
  const p = logPath()
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (!fs.existsSync(p)) fs.writeFileSync(p, '')
  } catch {
    /* best effort */
  }
  await shell.openPath(p)
}
