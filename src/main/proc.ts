import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * yt-dlp spawns ffmpeg as a child. child.kill() on Windows uses TerminateProcess
 * on the parent only, which orphans ffmpeg and leaves it holding the .part file
 * open. Kill the whole tree instead.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return

  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      /* process may already be gone */
    })
    return
  }

  try {
    // Spawned detached on POSIX, so the negative pid hits the whole group.
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }

  const pid = child.pid
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3000)
}

const PARTIAL_PATTERNS = [
  /\.part$/i,
  /\.part-Frag\d+$/i,
  /\.ytdl$/i,
  /\.temp\.[A-Za-z0-9]{1,5}$/i,
  /\.f\d+\.[A-Za-z0-9]{1,5}$/i
]

function isPartial(name: string): boolean {
  return PARTIAL_PATTERNS.some((re) => re.test(name))
}

async function unlinkWithRetry(p: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fsp.unlink(p)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      // EBUSY/EPERM on Windows while the dying process still holds the handle.
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/**
 * Removes the debris a killed download leaves behind. Scoped to the video id when
 * we know it, otherwise to files touched since the job started, so we never delete
 * a partial belonging to another row.
 */
export async function cleanupPartials(
  dir: string,
  videoId: string | undefined,
  startedAt: number
): Promise<void> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return
  }

  const targets: string[] = []
  for (const name of entries) {
    if (!isPartial(name)) continue

    if (videoId) {
      if (!name.includes(`[${videoId}]`)) continue
    } else {
      try {
        const stat = fs.statSync(path.join(dir, name))
        if (stat.mtimeMs < startedAt - 5000) continue
      } catch {
        continue
      }
    }
    targets.push(path.join(dir, name))
  }

  await Promise.all(targets.map(unlinkWithRetry))
}
